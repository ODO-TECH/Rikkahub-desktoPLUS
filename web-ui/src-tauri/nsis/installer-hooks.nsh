; Rikkahub installer: ask the user where conversations / config / uploads should live.
;
; This file is `!include`d early by our custom installer template (nsis/installer.template.nsi).
; The actual `Page custom RikkahubDataDirPageCreate RikkahubDataDirPageLeave` directive lives
; in the template itself — placed right after MUI_PAGE_DIRECTORY so the wizard flows:
;   Welcome → License (optional) → Install Dir → Data Dir (this) → Install → Finish.
;
; After files are installed, NSIS_HOOK_POSTINSTALL persists the choice to a plain-text
; handoff file %APPDATA%\com.rikkahub.pc\installer-data-dir.txt. The Rust shell consumes
; it on next launch: merges the path into user-config.json (load-modify-save) and deletes
; the file. The installer NEVER writes user-config.json itself — that file has exactly one
; writer (the shell). 专题6教训:本钩子曾以覆盖模式重写整个 user-config.json 且只写
; data_dir 一个字段,每次升级都会抹掉 minimize_to_tray 等其他用户偏好("托盘设置
; 自己复活"的根因)。交接文件是纯文本裸路径(无 JSON 转义、无尾随换行)。
;
; UPGRADE SAFETY: on re-install, the page reads the previously persisted data_dir from
; user-config.json (written by the Rust shell), falling back to a still-unconsumed
; handoff file (installed but never launched), and SKIPS the page if it finds one.
; Without this, an existing user who once picked e.g. D:\MyData\rikkahub-data would have
; their data_dir silently reset to $INSTDIR\pc-data when they click "下一步" on the
; default-prefilled page, orphaning the old files in place. Cover-installs MUST preserve
; the existing choice.
;
; NOTE: We do not define `.onInit` — the Tauri template owns it.

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var RIKKAHUB_DATA_DIR
Var RIKKAHUB_DATA_TEXT
Var RIKKAHUB_DATA_BROWSE
Var RIKKAHUB_EXISTING_DATA_DIR
; B3(专题6复查):"1" = 用户真的在数据目录页上确认过选择(PageLeave 只在页面展示时运行)。
; 升级路径里页面被 Abort 跳过时,$RIKKAHUB_DATA_DIR 来自旧配置的 ANSI 回读(中文路径
; 会乱码),而那条路径下交接文件本就是纯冗余(同值幂等重写)——不写即可彻底断开
; "乱码预填 → 写回交接 → 壳层合并污染好配置"的链条。
Var RIKKAHUB_DATA_DIR_FROM_PAGE

Function RikkahubDataDirPageCreate
  ${If} $RIKKAHUB_DATA_DIR == ""
    ; Upgrade path: try to recover the user's previously chosen data_dir. If found, skip the
    ; page entirely so cover-install never loses track of their data.
    Call RikkahubReadExistingDataDir
    ${If} $RIKKAHUB_EXISTING_DATA_DIR != ""
      StrCpy $RIKKAHUB_DATA_DIR $RIKKAHUB_EXISTING_DATA_DIR
      Abort
    ${EndIf}
    ; Fresh install: default mirrors the user's chosen install dir — "数据路径默认跟着 exe 走".
    StrCpy $RIKKAHUB_DATA_DIR "$INSTDIR\pc-data"
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "选择数据保存位置" "对话记录、设置和上传的文件都会放在这里。"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ; 8-1:应用内没有更换数据目录的入口(升级安装也会跳过本页复用旧目录),文案不得承诺
  ; "应用内随时换位置"。待前端补齐迁移 UI(复制数据→校验→切指针→重启)后再恢复表述。
  ${NSD_CreateLabel} 0u 0u 100% 30u "Rikkahub 会把所有的对话历史、应用设置、上传的文件和导出的备份保存到下面的目录。$\r$\n请谨慎选择：安装后暂不支持在应用内更换位置。"

  ${NSD_CreateLabel} 0u 36u 100% 10u "数据保存目录："

  ${NSD_CreateText} 0u 50u 80% 14u "$RIKKAHUB_DATA_DIR"
  Pop $RIKKAHUB_DATA_TEXT

  ${NSD_CreateBrowseButton} 82% 50u 18% 14u "浏览..."
  Pop $RIKKAHUB_DATA_BROWSE
  ${NSD_OnClick} $RIKKAHUB_DATA_BROWSE RikkahubDataDirBrowse

  ${NSD_CreateLabel} 0u 72u 100% 30u "提示：放到 D 盘等大容量分区可以避免占用系统盘空间，但路径里最好不要包含中文字符。"

  nsDialogs::Show
FunctionEnd

Function RikkahubDataDirPageLeave
  ${NSD_GetText} $RIKKAHUB_DATA_TEXT $RIKKAHUB_DATA_DIR
  ${If} $RIKKAHUB_DATA_DIR == ""
    StrCpy $RIKKAHUB_DATA_DIR "$INSTDIR\pc-data"
  ${EndIf}
  StrCpy $RIKKAHUB_DATA_DIR_FROM_PAGE "1"
FunctionEnd

Function RikkahubDataDirBrowse
  nsDialogs::SelectFolderDialog "选择数据保存位置" "$RIKKAHUB_DATA_DIR"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $RIKKAHUB_DATA_TEXT "$0"
  ${EndIf}
FunctionEnd

; --- Recover existing data_dir --------------------------------------------------------
; Primary source: user-config.json, whose sole writer is the Rust shell
; (serde_json::to_string_pretty). It emits one line of the form:
;   `  "data_dir": "<json-escaped-path>"`
; with a fixed 2-space indent. We search for the literal prefix `"data_dir": "` (13 chars)
; and read until the next `"`. The path is JSON-escaped so `\\` becomes `\` via
; RikkahubUnescapeJson. Anything else (missing file, malformed JSON, `data_dir: null`)
; falls through to the secondary source: a still-unconsumed installer handoff file
; (raw path, single line) from an install that was never launched. Both missing leaves
; $RIKKAHUB_EXISTING_DATA_DIR empty, and the caller falls back to a fresh-install
; default — safe by design.
Function RikkahubReadExistingDataDir
  StrCpy $RIKKAHUB_EXISTING_DATA_DIR ""

  IfFileExists "$APPDATA\com.rikkahub.pc\user-config.json" 0 rded_handoff

  ClearErrors
  FileOpen $0 "$APPDATA\com.rikkahub.pc\user-config.json" r
  IfErrors rded_handoff

rded_loop:
  ClearErrors
  FileRead $0 $1
  IfErrors rded_close

  ${StrLoc} $2 $1 '"data_dir": "' ">"
  StrCmp $2 "" rded_loop

  IntOp $2 $2 + 13    ; len('"data_dir": "') == 13
  StrCpy $3 $1 "" $2

  ${StrLoc} $4 $3 '"' ">"
  StrCmp $4 "" rded_close
  StrCpy $3 $3 $4

  Push $3
  Call RikkahubUnescapeJson
  Pop $RIKKAHUB_EXISTING_DATA_DIR

rded_close:
  FileClose $0

rded_handoff:
  ; config json 没给出 data_dir → 查未消费的交接文件(装了但从没启动过的场景)。
  StrCmp $RIKKAHUB_EXISTING_DATA_DIR "" 0 rded_done
  IfFileExists "$APPDATA\com.rikkahub.pc\installer-data-dir.txt" 0 rded_done
  ClearErrors
  FileOpen $0 "$APPDATA\com.rikkahub.pc\installer-data-dir.txt" r
  IfErrors rded_done
  ; B3:新版交接文件是 UTF-16LE 带 BOM(FF FE),旧版安装器是 ANSI。嗅探 BOM 分派:
  ; FileReadUTF16LE 自动跳过 BOM(NSIS 3.0b3+),ANSI 旧文件走原 FileRead 兼容。
  FileReadByte $0 $2
  FileReadByte $0 $3
  FileSeek $0 0 SET
  ClearErrors
  ${If} $2 = 255
  ${AndIf} $3 = 254
    FileReadUTF16LE $0 $1
  ${Else}
    FileRead $0 $1
  ${EndIf}
  FileClose $0
  IfErrors rded_done
  StrCpy $RIKKAHUB_EXISTING_DATA_DIR $1
rded_done:
FunctionEnd

; --- Tauri post-install hook --------------------------------------------------------
; Persist the user's choice to the plain-text handoff file. The Rust shell consumes it
; on next launch (merge into user-config.json, then delete). We deliberately do NOT
; write user-config.json here: rewriting a JSON we don't fully parse clobbers every
; field we don't know about (this is how minimize_to_tray kept resurrecting on updates).
;
; B3(专题6复查)两处改动:
; 1. 只在用户真的在页面上确认过选择时才写交接(FROM_PAGE 门禁)。页面被跳过的升级
;    路径里配置已持有同值,重写是纯冗余,且 ANSI 回读的中文路径已乱码——写回反而
;    把好配置改坏(用户会以为数据全丢)。静默安装(/S)不进自定义页,同样不写。
; 2. FileWriteUTF16LE /BOM 代替 FileWrite:Unicode NSIS 的 FileWrite 按系统 ANSI 码页
;    写出,壳层按 UTF-8 读,含中文路径必读失败 → 安装器选择被静默忽略且文件永不
;    删除。壳层侧按 BOM 双格式解码(兼容旧 ANSI 文件),同安装包内两侧天然同版。
; No trailing newline — the shell and RikkahubReadExistingDataDir read the line as-is.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $RIKKAHUB_DATA_DIR != ""
  ${AndIf} $RIKKAHUB_DATA_DIR_FROM_PAGE == "1"
    CreateDirectory "$APPDATA\com.rikkahub.pc"
    FileOpen $1 "$APPDATA\com.rikkahub.pc\installer-data-dir.txt" w
    FileWriteUTF16LE /BOM $1 '$RIKKAHUB_DATA_DIR'
    FileClose $1
    CreateDirectory "$RIKKAHUB_DATA_DIR"
  ${EndIf}
!macroend

; JSON unescape helper: turns `\\` into `\`. Other escapes (e.g. `\"`, `\n`) are left
; alone — our paths only contain backslashes. Stack in/out, same convention as escape.
Function RikkahubUnescapeJson
  Exch $0
  Push $1
  Push $2
  Push $3
  StrCpy $1 0
  StrCpy $2 ""
unesc_loop:
  StrCpy $3 $0 1 $1
  StrCmp $3 "" unesc_done
  StrCmp $3 "\" 0 unesc_keep
  IntOp $1 $1 + 1
  StrCpy $3 $0 1 $1
  StrCmp $3 "" unesc_trailing
  StrCmp $3 "\" 0 unesc_other
  StrCpy $2 "$2\"
  IntOp $1 $1 + 1
  Goto unesc_loop
unesc_other:
  StrCpy $2 "$2\$3"
  IntOp $1 $1 + 1
  Goto unesc_loop
unesc_trailing:
  StrCpy $2 "$2\"
  Goto unesc_done
unesc_keep:
  StrCpy $2 "$2$3"
  IntOp $1 $1 + 1
  Goto unesc_loop
unesc_done:
  Pop $3
  Pop $1
  Exch $2
  Exch
  Pop $0
FunctionEnd
