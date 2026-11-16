// Synthetic source-contract regressions. Authored for scheduled CI; no production database or private titles.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {loadTs,SRC}=require('./helpers/load-ts.cjs');
const L=loadTs('lib/reading-list.ts');
const S=loadTs('lib/reading-list-server.ts');
let serial=0;
const key=()=>`00000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`;
const parse=(body)=>{const r=L.parseListOp(body);assert.equal(r.ok,true);return r.op;};
const item=(overrides={})=>({book_id:7,slug:'synthetic-book',title:'Synthetic Book',author:null,edition:null,position:1024,version:1,status:'queued',listed:true,created_at:'2026-01-01T12:00:00Z',...overrides});
const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
const success=(body,version=1,extra={})=>({success:true,book_id:7,op_version:version,item:item({title:body.title,author:body.author??null,edition:body.edition??null,version}),...extra});

test('normalization checks real ISBN digits, canonical equivalence and blank metadata',()=>{
  assert.equal(L.normalizeIdentifier('0-306-40615-2'),'9780306406157');
  assert.equal(L.normalizeIdentifier('9780306406158'),undefined);
  assert.deepEqual(L.identityForms('9780306406157'),['9780306406157','0306406152']);
  const k=key();
  const a=parse({op:'create',op_key:k,title:' Synthetic  Book ',author:'',edition:'0-306-40615-2'});
  const b=parse({op:'create',op_key:k,title:'Synthetic Book',author:null,edition:'9780306406157'});
  assert.equal(S.payloadHash(a),S.payloadHash(b));
  assert.notEqual(S.payloadHash(a),S.payloadHash({...b,title:'Different Synthetic Book'}));
  assert.equal(L.parseListOp({op:'create',op_key:k,title:'x',unknown:true}).ok,false);
  assert.equal(L.parseListOp({op:'start',op_key:k,book_id:7,expected_version:1,start_date:'2026-02-30'}).ok,false);
});

test('lost create response replays exact body before newer words, including reload',()=>{
  let d={...L.newDraft(),fields:{title:'Synthetic One',author:'',edition:''}};
  const first=L.nextSend(d,key);d=first.draft;
  d={...d,fields:{...d.fields,author:'Synthetic Author'}};
  const s=storage();assert.equal(L.writeLocal(s,{...L.emptyLocal(),add:d}),true);
  d=L.readLocal(s).add;
  assert.deepEqual(L.nextSend(d,key).body,first.body);
  d=L.applyAnswer(d,first.body,200,success(first.body)).draft;
  assert.equal(d.saved.author,null);
  assert.equal(d.fields.author,'Synthetic Author');
  const next=L.nextSend(d,key);
  assert.equal(next.body.op,'edit');assert.equal(next.body.book_id,7);
  assert.equal(next.body.expected_version,1);assert.equal(next.body.author,'Synthetic Author');
  assert.notEqual(next.body.op_key,first.body.op_key);
});

test('edit baseline remains the version shown even after a refreshed list exists',()=>{
  let d=L.editDraft(item());d={...d,fields:{...d.fields,title:'My synthetic edit'}};
  const refreshed=item({version:2,title:'Other synthetic edit'});
  const send=L.nextSend(d,key);assert.equal(send.body.expected_version,1);
  const result=L.applyAnswer(send.draft,send.body,409,{error:'changed',item:refreshed});
  assert.equal(result.outcome.kind,'conflict');assert.equal(L.nextSend(result.draft,key),null);
  const mine=L.nextSend(L.keepMine(result.draft),key);
  assert.equal(mine.body.expected_version,2);assert.equal(mine.body.title,'My synthetic edit');
  assert.equal(L.draftSettled(L.takeSaved(result.draft)),true);
});

test('old applied edit replay never rebases newer desired words to an unseen later version',()=>{
  let d=L.editDraft(item());d={...d,fields:{...d.fields,title:'Synthetic Revision Two'}};
  const sent=L.nextSend(d,key);d={...sent.draft,fields:{...d.fields,title:'Synthetic Later Desired'}};
  const r=L.applyAnswer(d,sent.body,200,{...success(sent.body,2),item:item({version:4,title:'Elsewhere'})});
  const next=L.nextSend(r.draft,key);
  assert.equal(next.body.expected_version,2);assert.equal(next.body.title,'Synthetic Later Desired');
});

test('restored unsaved draft has no autosave baseline, so explicit Keep really sends',()=>{
  const fresh={...L.newDraft(),fields:{title:'Synthetic Restored',author:'',edition:''}};
  assert.equal(L.draftBaseline(fresh),undefined);
  const {Autosaver}=loadTs('lib/autosave.ts');
  const saved=[];
  const saver=new Autosaver({save:async v=>saved.push(v),delayMs:null},L.draftBaseline(fresh));
  assert.equal(saved.length,0,'constructing/restoring never sends');
  saver.change(fresh.fields,{delayMs:null});
  return saver.flush().then(()=>{assert.equal(saved.length,1);saver.dispose();});
});

test('dirty editor draft and pending action survive device roundtrip without automatic network work',()=>{
  const d=L.editDraft(item());d.fields.author='Synthetic retained author';
  const s=storage();const local=L.withDraft(L.emptyLocal(),7,d);
  assert.equal(L.writeLocal(s,local),true);
  const recovered=L.readLocal(s).edits['7'];
  assert.equal(recovered.base_version,1);assert.equal(recovered.fields.author,'Synthetic retained author');
  assert.equal(L.draftBaseline(recovered),undefined);
  assert.equal(L.writeLocal(s,L.withDraft(local,7,null)),true);
  assert.deepEqual(L.readLocal(s),L.emptyLocal());
});

test('storage denial prevents reserving a mutation; full queue never evicts unresolved requests',()=>{
  const body={op:'remove',op_key:key(),book_id:7,expected_version:1};
  assert.equal(L.recordPending(null,L.emptyLocal(),body,1).reason,'storage');
  const denied={getItem(){throw Error('blocked');},setItem(){throw Error('quota');},removeItem(){throw Error('blocked');}};
  assert.equal(L.recordPending(denied,L.emptyLocal(),body,1).reason,'storage');
  let local=L.emptyLocal();const s=storage();
  for(let i=0;i<L.MAX_PENDING;i++){const r=L.recordPending(s,local,{...body,op_key:key()},i);assert.equal(r.ok,true);local=r.local;}
  const first=local.pending[0].body.op_key;
  assert.equal(L.recordPending(s,local,{...body,op_key:key()},99).reason,'full');
  assert.equal(L.readLocal(s).pending[0].body.op_key,first);
  const legacyLarge={...local,pending:[...local.pending,{body:{...body,op_key:key()},at:100}]};
  L.writeLocal(s,legacyLarge);assert.equal(L.readLocal(s).pending.length,L.MAX_PENDING+1);
});

test('replayed removed create is held instead of claiming it is on the list',()=>{
  const sent=L.nextSend({...L.newDraft(),fields:{title:'Synthetic',author:'',edition:''}},key);
  const r=L.applyAnswer(sent.draft,sent.body,200,{...success(sent.body),item:item({listed:false,status:'reading'})});
  assert.equal(r.outcome.kind,'not_listed');assert.equal(r.draft.book_id,null);
  assert.equal(r.draft.fields.title,'Synthetic');
});

test('duplicate decision is a new payload and operation key after a definite refusal',()=>{
  const first=L.nextSend({...L.newDraft(),fields:{title:'Synthetic',author:'',edition:''}},key);
  const refused=L.applyAnswer(first.draft,first.body,409,{error:'duplicate',candidates:[],distinct_allowed:true});
  const next=L.nextSend({...refused.draft,resolve:'distinct'},key);
  assert.notEqual(next.body.op_key,first.body.op_key);assert.equal(next.body.resolve,'distinct');
});

function fakeServer(result,error=null,readError=null){
  const calls=[];
  const row={book_id:7,slug:'synthetic-book',title:'Synthetic Book',author:null,status:'queued',edition_identifier:null,list_position:1024,list_removed_at:null,list_version:1,created_at:'2026-01-01'};
  const client={rpc:async(name,args)=>{calls.push({name,args});return {data:result,error};},from:()=>{
    const q={select:()=>q,eq:()=>q,is:()=>q,order:()=>q,maybeSingle:async()=>({data:row,error:readError}),then:(yes,no)=>Promise.resolve({data:[row],error:readError}).then(yes,no)};
    return q;
  }};return {client,calls};
}

test('server routes mutations through one atomic RPC, preserving start replay metadata',async()=>{
  const f=fakeServer({ok:true,book_id:7,version:2,replayed:true,started:'synthetic-book'});
  const op=parse({op:'start',op_key:key(),book_id:7,expected_version:1,start_date:null});
  const r=await S.applyListOp(f.client,op);
  assert.equal(r.status,200);assert.equal(r.body.started,'synthetic-book');assert.equal(r.body.op_version,2);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'reading_list_apply');
  assert.equal(f.calls[0].args.p.payload_hash,S.payloadHash(op));
});

test('RPC failure is not success and never falls back to direct row writes',async()=>{
  const op=parse({op:'create',op_key:key(),title:'Synthetic'});
  for(const [code,status] of [['PGRST202',503],['23505',500],['57014',500]]){
    const f=fakeServer(null,{code});const r=await S.applyListOp(f.client,op);
    assert.equal(r.status,status);assert.equal(f.calls.length,1);
  }
  const conflict=fakeServer({ok:false,http:409,code:'key_reused'});
  assert.equal((await S.applyListOp(conflict.client,op)).body.error,'key_reused');
});

test('successful mutation remains acknowledged if follow-up display read fails',async()=>{
  const f=fakeServer({ok:true,book_id:7,version:1},{}, {code:'57014'});
  // No RPC error: the two display reads fail after the operation already committed.
  f.client.rpc=async()=>({data:{ok:true,book_id:7,version:1},error:null});
  const r=await S.applyListOp(f.client,parse({op:'create',op_key:key(),title:'Synthetic'}));
  assert.equal(r.status,200);assert.equal(r.body.book_id,7);assert.equal(r.body.items,null);assert.equal(r.body.item,null);
});

test('order intent is bound to the shown full order; queued books never become default quests',()=>{
  const k=key();const a=parse({op:'move',op_key:k,book_id:7,direction:'up',expected_order:[2,7]});
  const b=parse({op:'move',op_key:k,book_id:7,direction:'up',expected_order:[3,7]});
  assert.notEqual(S.payloadHash(a),S.payloadHash(b));
  assert.equal(L.parseListOp({...a,expected_order:[7,7]}).ok,false);
  assert.deepEqual(L.questBooks([{slug:'q',status:'queued'},{slug:'r',status:'reading'}],'r').map(x=>x.slug),['r']);
});

test('SQL mutation boundary retains serialization, immutable receipt and restricted execution',()=>{
  const sql=fs.readFileSync(path.join(SRC,'..','..','sql','reading_want_list.sql'),'utf8');
  assert.match(sql,/SECURITY INVOKER/);
  assert.match(sql,/REVOKE ALL ON FUNCTION pds\.reading_list_apply\(JSONB\) FROM PUBLIC, anon, authenticated/);
  assert.ok(sql.indexOf('pg_advisory_xact_lock')<sql.indexOf('SELECT * INTO v_prior'));
  assert.match(sql,/v_ids IS DISTINCT FROM v_expect/);
  assert.match(sql,/v_prior\.payload_hash <> v_hash/);
  assert.ok(sql.indexOf('INSERT INTO pds.reading_list_ops')>sql.indexOf('ELSIF v_kind = \'move\''));
  assert.doesNotMatch(sql,/DELETE FROM pds\.books|UPDATE pds\.book_highlights|UPDATE pds\.reading_sessions/i);
  // Real rollback/concurrency behavior is an independent SQL-review and post-release fixture obligation.
});
