// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * The words around the caret in the focused field, through Windows UI Automation, so dictated text
 * can fit them. Native editors answer; Chrome, Electron apps and terminals mostly do not, and the
 * caller then falls back to what it last inserted.
 */
import * as NodeChildProcess from "node:child_process";

import type { CaretContext } from "@t3tools/tessaya-shared/dictationFit";

/** How much text either side is read: enough for the last sentence and the next word. */
const CHARS = 120;

const SCRIPT = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$e=[System.Windows.Automation.AutomationElement]::FocusedElement
if($null -eq $e){'{}';exit}
$o=@{}
try{
 $t=$e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
 $s=$t.GetSelection()
 if($s.Count -gt 0){
  $r=$s[0]
  $b=$r.Clone();$b.MoveEndpointByRange('End',$r,'Start');$b.MoveEndpointByUnit('Start','Character',-${CHARS})
  $a=$r.Clone();$a.MoveEndpointByRange('Start',$r,'End');$a.MoveEndpointByUnit('End','Character',${CHARS})
  $o.before=$b.GetText(${CHARS});$o.after=$a.GetText(${CHARS})
 }
}catch{}
if($null -eq $o.before){
 try{
  $v=$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
  if($v -eq ''){$o.before='';$o.after=''}
 }catch{}
}
$o|ConvertTo-Json -Compress
`;

/** Reads the PowerShell answer; anything that is not both strings means the field did not say. */
export const parseCaretContext = (stdout: string): CaretContext | null => {
  try {
    const value = JSON.parse(stdout.trim()) as { before?: unknown; after?: unknown };
    return typeof value.before === "string" && typeof value.after === "string"
      ? { before: value.before, after: value.after }
      : null;
  } catch {
    return null;
  }
};

export const readCaretContext = (
  platform: string,
  timeoutMs = 1_500,
): Promise<CaretContext | null> =>
  platform !== "win32"
    ? Promise.resolve(null)
    : new Promise((resolve) => {
        NodeChildProcess.execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(SCRIPT, "utf16le").toString("base64"),
          ],
          { timeout: timeoutMs, windowsHide: true },
          (error, stdout) => resolve(error === null ? parseCaretContext(stdout) : null),
        );
      });
