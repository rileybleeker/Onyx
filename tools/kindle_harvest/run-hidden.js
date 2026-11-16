// Windows Script Host (JScript) launcher — NOT Node. Task Scheduler runs this through wscript.exe
// so the harvester gets no console window, and node's exit code still reaches Task Scheduler's
// "Last Run Result" (conhost --headless hides the window too, but always reports 0).
//   wscript.exe //B //Nologo //E:JScript run-hidden.js [harvest.mjs args…]
//   wscript.exe //B //Nologo //E:JScript run-hidden.js run-listener.mjs
// A first argument ending in .mjs names the script in this folder (the Run now listener); without
// one it runs harvest.mjs, as the "Onyx Kindle Harvest" task does.
var fso = new ActiveXObject("Scripting.FileSystemObject");
var sh = new ActiveXObject("WScript.Shell");
var here = fso.GetParentFolderName(WScript.ScriptFullName);
var node = sh.ExpandEnvironmentStrings("%ProgramFiles%") + "\\nodejs\\node.exe";
var script = "harvest.mjs";
var first = 0;
if (WScript.Arguments.length > 0 && /^[A-Za-z0-9_-]+\.mjs$/.test(WScript.Arguments(0))) {
  script = WScript.Arguments(0);
  first = 1;
}
var cmd = '"' + node + '" "' + here + '\\' + script + '"';
for (var i = first; i < WScript.Arguments.length; i++) cmd += ' "' + WScript.Arguments(i) + '"';
WScript.Quit(sh.Run(cmd, 0, true)); // 0 = hidden window, true = wait for exit
