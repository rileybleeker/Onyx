// Windows Script Host (JScript) launcher — NOT Node. Task Scheduler runs this through wscript.exe
// so the harvester gets no console window, and node's exit code still reaches Task Scheduler's
// "Last Run Result". Same launcher as tools/kindle_harvest and tools/ubereats_harvest.
//   wscript.exe //B //Nologo //E:JScript run-hidden.js [harvest.mjs args…]
var fso = new ActiveXObject("Scripting.FileSystemObject");
var sh = new ActiveXObject("WScript.Shell");
var here = fso.GetParentFolderName(WScript.ScriptFullName);
var node = sh.ExpandEnvironmentStrings("%ProgramFiles%") + "\\nodejs\\node.exe";
var cmd = '"' + node + '" "' + here + '\\harvest.mjs"';
for (var i = 0; i < WScript.Arguments.length; i++) cmd += ' "' + WScript.Arguments(i) + '"';
WScript.Quit(sh.Run(cmd, 0, true)); // 0 = hidden window, true = wait for exit
