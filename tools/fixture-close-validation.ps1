# tools/fixture-close-validation.ps1
# 真实桌面退出故障验收脚本 (task-14)
# 仅针对 debug --fixture 隔离存档与测试窗口，通过 CDP 注入与 Windows 原生 #32770 对话框自动化操作。
# 不修改或关闭其他应用窗口，不触碰真实用户存档。

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ExePath,

    [Parameter(Mandatory = $false)]
    [string]$NodePath = "node",

    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $false)]
    [int]$Port = 23389,

    [Parameter(Mandatory = $false)]
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# 1. 路径解析与安全断言 (Path Resolution & Assertions)
# ---------------------------------------------------------------------------
if (-not $ProjectRoot) {
    $ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
} else {
    $ProjectRoot = (Resolve-Path $ProjectRoot).Path
}

$expectedDebugDir = [System.IO.Path]::GetFullPath("$ProjectRoot\target\debug")
$expectedDebugDirWithSep = $expectedDebugDir.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar

# 默认可执行文件名修正为桌面项目的 ashfall-local.exe
if (-not $ExePath) {
    $ExePath = [System.IO.Path]::Combine($expectedDebugDir, "ashfall-local.exe")
}

# 必须断言 EXE 为绝对路径且严格位于 project target\debug\ 目录内（加分隔符防 target\debug-evil 绕过）
if (-not [System.IO.Path]::IsPathRooted($ExePath)) {
    throw "ExePath 必须是绝对路径: $ExePath"
}

$canonicalExe = [System.IO.Path]::GetFullPath($ExePath)
if (-not $canonicalExe.ToLowerInvariant().StartsWith($expectedDebugDirWithSep.ToLowerInvariant())) {
    throw "安全断言失败: ExePath 必须严格位于项目的 target\debug\ 目录下。当前路径: $canonicalExe; 期望目录前缀: $expectedDebugDirWithSep"
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " 星际争霸：余烬 - 桌面退出故障验收脚本 (task-14)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "项目根目录: $ProjectRoot"
Write-Host "执行程序:   $canonicalExe"
Write-Host "Node.js:    $NodePath"
Write-Host "CDP 调试端口: $Port"

# ---------------------------------------------------------------------------
# 2. P/Invoke Win32 API 注册 (Add-Type only test automation)
# ---------------------------------------------------------------------------
$win32Source = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class NativeWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@

if (-not ([System.Management.Automation.PSTypeName]'NativeWin32').Type) {
    Add-Type -TypeDefinition $win32Source
}

# Win32 常量与 WM_COMMAND 按钮 ID (4retry, 2cancel, 7no, 6yes, 1ok)
$WM_COMMAND   = 0x0111
$WM_CLOSE     = 0x0010
$DM_GETDEFID  = 0x0400

$IDOK     = 1
$IDCANCEL = 2
$IDRETRY  = 4
$IDYES    = 6
$IDNO     = 7

# ---------------------------------------------------------------------------
# 3. 辅助函数 (Helpers)
# ---------------------------------------------------------------------------

function Invoke-CdpExpression {
    param (
        [string]$JsCode,
        [int]$CdpPort
    )
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsCode)
    $b64 = [Convert]::ToBase64String($bytes)
    $helperScript = "$ProjectRoot\tools\fixture-close-validation.test.mjs"

    $raw = & $NodePath $helperScript --cdp-eval --port $CdpPort --code-b64 $b64
    if ($LASTEXITCODE -ne 0) {
        throw "CDP 评估调用失败 (ExitCode $LASTEXITCODE): $raw"
    }
    $res = $raw | ConvertFrom-Json
    if (-not $res.success) {
        throw "CDP 脚本执行返回错误: $($res.error | ConvertTo-Json -Compress)"
    }
    return $res.value
}

function Wait-CdpReady {
    param (
        [int]$CdpPort,
        [double]$TimeoutSeconds = 25.0
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        try {
            $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 2 -ErrorAction Stop
            $page = $pages | Where-Object { $_.type -eq 'page' -and $_.url -match '^http://127\.0\.0\.1:\d+/' -and -not ($_.url -like '*__bootstrap*') }
            if ($page) {
                return $true
            }
        } catch {
            # WebView2 尚未建立调试端点，继续轮询
        }
        Start-Sleep -Milliseconds 250
    }
    throw "超时: WebView2 页面未能在 ${TimeoutSeconds} 秒内于 CDP 端口 $CdpPort 出现"
}

function Find-ProcessMainWindow {
    param (
        [int]$TargetPid,
        [double]$TimeoutSeconds = 15.0
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
            return $proc.MainWindowHandle
        }
        $script:foundMainHwnd = [IntPtr]::Zero
        $enumProc = {
            param($hWnd, $lParam)
            $wPid = 0
            [NativeWin32]::GetWindowThreadProcessId($hWnd, [ref]$wPid) | Out-Null
            if ($wPid -eq $TargetPid) {
                $sb = [System.Text.StringBuilder]::new(256)
                [NativeWin32]::GetClassName($hWnd, $sb, 256) | Out-Null
                $cls = $sb.ToString()
                if ($cls -ne "#32770") {
                    $script:foundMainHwnd = $hWnd
                    return $false
                }
            }
            return $true
        }
        [NativeWin32]::EnumWindows($enumProc, [IntPtr]::Zero) | Out-Null
        if ($script:foundMainHwnd -ne [IntPtr]::Zero) {
            return $script:foundMainHwnd
        }
        Start-Sleep -Milliseconds 200
    }
    return [IntPtr]::Zero
}

function Find-NativeDialog {
    param (
        [int]$TargetPid,
        [double]$TimeoutSeconds = 30.0
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $script:dialogHwnd = [IntPtr]::Zero
        $script:dialogTitle = ""
        $enumProc = {
            param($hWnd, $lParam)
            $wPid = 0
            [NativeWin32]::GetWindowThreadProcessId($hWnd, [ref]$wPid) | Out-Null
            if ($wPid -eq $TargetPid) {
                $sbClass = [System.Text.StringBuilder]::new(256)
                [NativeWin32]::GetClassName($hWnd, $sbClass, 256) | Out-Null
                if ($sbClass.ToString() -eq "#32770") {
                    $sbTitle = [System.Text.StringBuilder]::new(256)
                    [NativeWin32]::GetWindowText($hWnd, $sbTitle, 256) | Out-Null
                    $script:dialogHwnd = $hWnd
                    $script:dialogTitle = $sbTitle.ToString()
                    return $false # 找到属于该 PID 的原生对话框，停止枚举
                }
            }
            return $true
        }
        [NativeWin32]::EnumWindows($enumProc, [IntPtr]::Zero) | Out-Null
        if ($script:dialogHwnd -ne [IntPtr]::Zero) {
            return @{
                Hwnd = $script:dialogHwnd
                Title = $script:dialogTitle
                ElapsedMs = $sw.ElapsedMilliseconds
            }
        }
        Start-Sleep -Milliseconds 100
    }
    return $null
}

function Get-DialogDefaultButtonId {
    param ([IntPtr]$DialogHwnd)
    $res = [NativeWin32]::SendMessage($DialogHwnd, $DM_GETDEFID, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    return ($res -band 0xFFFF)
}

function Send-DialogButtonClick {
    param (
        [IntPtr]$DialogHwnd,
        [int]$ButtonId
    )
    $btnHwnd = [NativeWin32]::GetDlgItem($DialogHwnd, $ButtonId)
    # WM_COMMAND with LOWORD(wParam) = ButtonId
    [NativeWin32]::SendMessage($DialogHwnd, $WM_COMMAND, [IntPtr]$ButtonId, $btnHwnd) | Out-Null
}

function Start-FixtureProcess {
    param (
        [string]$ExeFilePath,
        [int]$CdpPort
    )
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $ExeFilePath
    $psi.Arguments = "--fixture"
    $psi.EnvironmentVariables["ASHFALL_FIXTURE_DEBUG_PORT"] = "$CdpPort"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $false

    $proc = [System.Diagnostics.Process]::Start($psi)
    if (-not $proc -or $proc.Id -le 0) {
        throw "无法启动调试夹具进程: $ExeFilePath"
    }

    # 关键合规修复：短 deadline 3s 重试 refresh 验证路径，消除 Windows OS Loader 启动瞬态 Path 为空的早死问题
    $swPath = [System.Diagnostics.Stopwatch]::StartNew()
    $pathMatched = $false
    $lastObservedPath = ""

    while ($swPath.Elapsed.TotalSeconds -lt 3.0) {
        if ($proc.HasExited) {
            throw "夹具进程在启动后立即异常退出 (ExitCode: $($proc.ExitCode))"
        }
        try {
            $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
            if ($p) {
                $p.Refresh()
                $candidate = $p.Path
                if (-not $candidate -and $p.MainModule) {
                    $candidate = $p.MainModule.FileName
                }
                if ($candidate) {
                    $lastObservedPath = $candidate
                    if ([string]::Equals($candidate, $ExeFilePath, [System.StringComparison]::OrdinalIgnoreCase)) {
                        $pathMatched = $true
                        break
                    }
                }
            }
        } catch {
            # 启动瞬间可能出现 Win32Exception 权限瞬态，继续等待
        }
        Start-Sleep -Milliseconds 100
    }

    if (-not $pathMatched) {
        try { $proc.Kill($true) } catch {}
        throw "进程路径验证失败: 无法在 3 秒内确认进程 $ExeFilePath。最后观察路径: '$lastObservedPath' (PID: $($proc.Id))"
    }

    return $proc
}

function Stop-FixtureProcessSafely {
    param (
        [System.Diagnostics.Process]$Proc,
        [int]$CdpPort = 23389
    )
    if ($Proc -and -not $Proc.HasExited) {
        try {
            # 关键合规修复：Kill(entireProcessTree: true) 彻底终止属于此进程的 WebView2 子进程树，防止端口残留
            $Proc.Kill($true)
            $Proc.WaitForExit(5000)
        } catch {}
    }

    # 等待 CDP 调试端口释放，防止下一场景绑定冲突或连接到僵尸 WebView
    $swPort = [System.Diagnostics.Stopwatch]::StartNew()
    while ($swPort.Elapsed.TotalSeconds -lt 3.0) {
        try {
            $res = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 1 -ErrorAction Stop
            Start-Sleep -Milliseconds 100
        } catch {
            # 端口已成功释放/不可达
            break
        }
    }
}

# ---------------------------------------------------------------------------
# 4. DryRun 模式分支
# ---------------------------------------------------------------------------
$validationReportDir = "$ProjectRoot\target\validation"
$reportPath = "$validationReportDir\fixture-close-faults.json"
$dryRunReportPath = "$validationReportDir\fixture-close-dryrun.json"

if ($DryRun) {
    Write-Host "[DryRun] 执行自检与语法校验模式 (不产出虚假 allPassed 报告)..." -ForegroundColor Yellow
    [System.IO.Directory]::CreateDirectory($validationReportDir) | Out-Null
    $dryRunReport = [ordered]@{
        timestamp = (Get-Date).ToString("o")
        exePath = $canonicalExe
        dryRun = $true
        status = "NOT_RUN"
        scope = "syntax_only"
        allPassed = $null
        scenarios = @(
            [ordered]@{ name = "fail_cancel_no"; passed = $null; note = "syntax dry run only - not executed" },
            [ordered]@{ name = "fail_retry_exit0"; passed = $null; note = "syntax dry run only - not executed" },
            [ordered]@{ name = "never_resolve_timeout"; passed = $null; note = "syntax dry run only - not executed" },
            [ordered]@{ name = "explicit_discard"; passed = $null; note = "syntax dry run only - not executed" }
        )
    }
    $dryRunReport | ConvertTo-Json -Depth 5 | Set-Content $dryRunReportPath -Encoding UTF8
    Write-Host "[DryRun] 语法与结构校验完成，独立 dryrun 报告已输出至: $dryRunReportPath" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# 5. 真实故障场景验收测试 (4 个核心场景)
# ---------------------------------------------------------------------------
if (-not (Test-Path -PathType Leaf $canonicalExe)) {
    throw "调试版可执行文件不存在: $canonicalExe。请等待 Lead 完成 cargo build --debug 后再运行此脚本。"
}

[System.IO.Directory]::CreateDirectory($validationReportDir) | Out-Null

$probeDataDir = [System.IO.Path]::Combine($env:LOCALAPPDATA, "StarCraftAshfallClientProbe")
$saveJsonPath = [System.IO.Path]::Combine($probeDataDir, "save.json")

$results = [System.Collections.Generic.List[PSObject]]::new()
$allPassed = $true

# ---------------------------------------------------------------------------
# 场景 1: fail -> cancel -> No (保存失败 -> 点击取消 -> 确认放弃选择No -> 窗口仍存活、RAF恢复、dirty保留)
# ---------------------------------------------------------------------------
Write-Host "`n------------------------------------------------------------" -ForegroundColor Cyan
Write-Host " 执行场景 1: fail -> cancel -> No (验证取消后游戏窗口继续运行且保留脏数据)" -ForegroundColor Cyan
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan

$proc1 = $null
$s1Passed = $false
$s1Details = @{}
$uuid1 = [Guid]::NewGuid().ToString("N")
$markerKey1 = "probe-scenario1-$uuid1"
$markerVal1 = "dirty-val-$uuid1"

try {
    $proc1 = Start-FixtureProcess -ExeFilePath $canonicalExe -CdpPort $Port
    Write-Host "  [进程启动] PID=$($proc1.Id), 等待 CDP 就绪..."
    Wait-CdpReady -CdpPort $Port
    $mainHwnd = Find-ProcessMainWindow -TargetPid $proc1.Id
    if ($mainHwnd -eq [IntPtr]::Zero) { throw "未找到主窗口 HWND" }

    # 关键合规修复：注入前先 await original.freeze()，禁止后台 100ms 防抖偷偷落盘
    Write-Host "  [CDP 注入] 先调用 original.freeze() 冻结后台防抖，再修改 storage 并安装 mock..."
    $injectCode1 = @"
    (async () => {
        window.__VALIDATION_ORIGINAL__ = window.__VALIDATION_ORIGINAL__ || window.__ASHFALL_BRIDGE__;
        const orig = window.__VALIDATION_ORIGINAL__;
        if (orig && typeof orig.freeze === 'function') {
            await orig.freeze();
        }
        localStorage.setItem('$markerKey1', '$markerVal1');
        let isDirty = true;
        window.__ASHFALL_BRIDGE__ = {
            freeze: async () => { if (orig && typeof orig.freeze === 'function') await orig.freeze(); },
            thaw: () => { isDirty = true; },
            isDirty: () => isDirty,
            getRevision: () => (orig && typeof orig.getRevision === 'function') ? orig.getRevision() : 0,
            flush: async () => { throw new Error("场景1注入保存故障"); }
        };
        window.__RAF_COUNT__ = 0;
        const loop = () => { window.__RAF_COUNT__++; requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        return { injected: true };
    })()
"@
    Invoke-CdpExpression -JsCode $injectCode1 -CdpPort $Port | Out-Null

    # 触发关闭请求
    Write-Host "  [发送 WM_CLOSE] 向主窗口 HWND $mainHwnd 发送原生关闭消息..."
    [NativeWin32]::PostMessage($mainHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null

    # 步骤 1：等待第一个对话框 (Retry / Cancel 提示)
    Write-Host "  [原生对话框 1] 等待 #32770 重试/取消 对话框..."
    $dlg1 = Find-NativeDialog -TargetPid $proc1.Id -TimeoutSeconds 15.0
    if (-not $dlg1) { throw "未在超时内检测到退出重试对话框" }
    $defBtn1 = Get-DialogDefaultButtonId -DialogHwnd $dlg1.Hwnd
    Write-Host "  [原生对话框 1] 捕获 HWND=$($dlg1.Hwnd), 默认聚焦按钮ID=$defBtn1 (期望 IDCANCEL=$IDCANCEL)"
    $s1Details["dialog1_default_button"] = $defBtn1

    # 点击 Cancel (ID 2)
    Write-Host "  [操作 1] 发送 IDCANCEL ($IDCANCEL) 触发放弃二次确认..."
    Send-DialogButtonClick -DialogHwnd $dlg1.Hwnd -ButtonId $IDCANCEL

    # 步骤 2：等待第二个对话框 (Yes / No 确认放弃对话框)
    Write-Host "  [原生对话框 2] 等待 #32770 确认放弃 对话框..."
    $dlg2 = Find-NativeDialog -TargetPid $proc1.Id -TimeoutSeconds 10.0
    if (-not $dlg2) { throw "未在超时内检测到确认放弃对话框" }
    $defBtn2 = Get-DialogDefaultButtonId -DialogHwnd $dlg2.Hwnd
    Write-Host "  [原生对话框 2] 捕获 HWND=$($dlg2.Hwnd), 默认聚焦按钮ID=$defBtn2 (期望 IDNO=$IDNO)"
    $s1Details["dialog2_default_button"] = $defBtn2

    # 点击 No (ID 7) - 取消退出并返回游戏
    Write-Host "  [操作 2] 发送 IDNO ($IDNO) 取消退出并返回游戏..."
    Send-DialogButtonClick -DialogHwnd $dlg2.Hwnd -ButtonId $IDNO

    # 等待前端 resume 逻辑执行
    Start-Sleep -Milliseconds 500

    # 步骤 3：验证恢复状态 (窗口仍存活、遮罩已移除、RAF 继续循环、dirty 键保留)
    $procAlive = (-not $proc1.HasExited)
    $verifyCode = @"
    (() => {
        const overlay = document.getElementById('__ashfall_close_overlay__');
        const dirtyVal = localStorage.getItem('$markerKey1');
        const c1 = window.__RAF_COUNT__ || 0;
        return {
            hasOverlay: !!overlay,
            dirtyValue: dirtyVal,
            rafCount: c1
        };
    })()
"@
    $v1 = Invoke-CdpExpression -JsCode $verifyCode -CdpPort $Port
    Start-Sleep -Milliseconds 300
    $v2 = Invoke-CdpExpression -JsCode "window.__RAF_COUNT__" -CdpPort $Port
    $rafRunning = ($v2 -gt $v1.rafCount)

    # 恢复原始 bridge
    Invoke-CdpExpression -JsCode "(async () => { if (window.__VALIDATION_ORIGINAL__) { window.__ASHFALL_BRIDGE__ = window.__VALIDATION_ORIGINAL__; } })()" -CdpPort $Port | Out-Null

    $s1Details["window_alive"] = $procAlive
    $s1Details["overlay_removed"] = (-not $v1.hasOverlay)
    $s1Details["dirty_retained"] = ($v1.dirtyValue -eq $markerVal1)
    $s1Details["raf_running"] = $rafRunning

    # 必须 assert 双弹窗默认聚焦按钮合规 (IDCANCEL=2, IDNO=7)
    if ($procAlive -and ($defBtn1 -eq $IDCANCEL) -and ($defBtn2 -eq $IDNO) -and (-not $v1.hasOverlay) -and ($v1.dirtyValue -eq $markerVal1) -and $rafRunning) {
        $s1Passed = $true
        Write-Host "  [场景 1 验证通过] 默认按钮(2/7)校验通过，窗口仍存活、遮罩移除、RAF正常继续、唯一脏数据完好保留" -ForegroundColor Green
    } else {
        Write-Host "  [场景 1 验证失败] 详细状态: $($s1Details | ConvertTo-Json -Compress)" -ForegroundColor Red
    }
} catch {
    Write-Host "  [场景 1 异常]: $_" -ForegroundColor Red
    $s1Details["error"] = $_.ToString()
} finally {
    Stop-FixtureProcessSafely -Proc $proc1 -CdpPort $Port
}

$results.Add([PSCustomObject]@{
    name = "fail_cancel_no"
    passed = $s1Passed
    details = $s1Details
})
if (-not $s1Passed) { $allPassed = $false }

# ---------------------------------------------------------------------------
# 场景 2: fail -> restorebridge -> retry -> exit 0 (重试成功退出)
# ---------------------------------------------------------------------------
Write-Host "`n------------------------------------------------------------" -ForegroundColor Cyan
Write-Host " 执行场景 2: fail -> restorebridge -> retry -> exit 0 (重试成功退出并持久化)" -ForegroundColor Cyan
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan

$proc2 = $null
$s2Passed = $false
$s2Details = @{}
$uuid2 = [Guid]::NewGuid().ToString("N")
$markerKey2 = "probe-scenario2-$uuid2"
$markerVal2 = "retry-val-$uuid2"

try {
    $proc2 = Start-FixtureProcess -ExeFilePath $canonicalExe -CdpPort $Port
    Wait-CdpReady -CdpPort $Port
    $mainHwnd = Find-ProcessMainWindow -TargetPid $proc2.Id
    if ($mainHwnd -eq [IntPtr]::Zero) { throw "未找到主窗口 HWND" }

    # 读取初始 revision 基准
    $baselineRev = [int](Invoke-CdpExpression -JsCode "window.__ASHFALL_BRIDGE__ ? window.__ASHFALL_BRIDGE__.getRevision() : 0" -CdpPort $Port)
    $s2Details["baseline_revision"] = $baselineRev
    Write-Host "  [基准 Revision] $baselineRev"

    # 先 freeze 原始 bridge，再写入唯一 marker
    $injectCode2 = @"
    (async () => {
        window.__VALIDATION_ORIGINAL__ = window.__VALIDATION_ORIGINAL__ || window.__ASHFALL_BRIDGE__;
        const orig = window.__VALIDATION_ORIGINAL__;
        if (orig && typeof orig.freeze === 'function') {
            await orig.freeze();
        }
        localStorage.setItem('$markerKey2', '$markerVal2');
        let isDirty = true;
        window.__ASHFALL_BRIDGE__ = {
            freeze: async () => { if (orig && typeof orig.freeze === 'function') await orig.freeze(); },
            thaw: () => { isDirty = true; },
            isDirty: () => isDirty,
            getRevision: () => (orig && typeof orig.getRevision === 'function') ? orig.getRevision() : $baselineRev,
            flush: async () => { throw new Error("场景2首次flush失败"); }
        };
        return { injected: true };
    })()
"@
    Invoke-CdpExpression -JsCode $injectCode2 -CdpPort $Port | Out-Null

    # 发送关闭请求
    [NativeWin32]::PostMessage($mainHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null

    # 等待对话框 1 (Retry / Cancel)
    $dlg1 = Find-NativeDialog -TargetPid $proc2.Id -TimeoutSeconds 15.0
    if (-not $dlg1) { throw "未在超时内检测到重试对话框" }
    $defBtn1 = Get-DialogDefaultButtonId -DialogHwnd $dlg1.Hwnd
    $s2Details["dialog1_default_button"] = $defBtn1

    # 关键测试：在点击 Retry 之前恢复原始 bridge
    Write-Host "  [CDP 恢复] 在重试前恢复真实 window.__ASHFALL_BRIDGE__..."
    Invoke-CdpExpression -JsCode "(async () => { window.__ASHFALL_BRIDGE__ = window.__VALIDATION_ORIGINAL__; window.__VALIDATION_ORIGINAL__ = null; })()" -CdpPort $Port | Out-Null

    # 点击 Retry (ID 4)
    Write-Host "  [操作] 发送 IDRETRY ($IDRETRY) 触发重新保存与退出流程..."
    Send-DialogButtonClick -DialogHwnd $dlg1.Hwnd -ButtonId $IDRETRY

    # 等待进程退出
    Write-Host "  [等待退出] 等待进程正常退出 (ExitCode 0)..."
    $exited = $proc2.WaitForExit(15000)
    $s2Details["has_exited"] = $exited
    $s2Details["exit_code"] = if ($exited) { $proc2.ExitCode } else { -1 }

    # 严格校验：磁盘 save.json 必须包含本次 unique marker，且 revision 必须比 baselineRevision 增加
    $persisted = $false
    $revIncremented = $false
    if (Test-Path -PathType Leaf $saveJsonPath) {
        $saveContent = Get-Content $saveJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $actualRev = [int]$saveContent.revision
        $s2Details["saved_revision"] = $actualRev
        if ($actualRev -ge ($baselineRev + 1)) {
            $revIncremented = $true
        }
        if ($saveContent.values.$markerKey2 -eq $markerVal2) {
            $persisted = $true
        }
    }
    $s2Details["persisted_to_disk"] = $persisted
    $s2Details["revision_incremented"] = $revIncremented

    if ($exited -and ($proc2.ExitCode -eq 0) -and ($defBtn1 -eq $IDCANCEL) -and $persisted -and $revIncremented) {
        $s2Passed = $true
        Write-Host "  [场景 2 验证通过] 重试保存成功，ExitCode=0，revision确实增加($baselineRev -> $actualRev)，唯一数据落盘成功" -ForegroundColor Green
    } else {
        Write-Host "  [场景 2 验证失败] 详细状态: $($s2Details | ConvertTo-Json -Compress)" -ForegroundColor Red
    }
} catch {
    Write-Host "  [场景 2 异常]: $_" -ForegroundColor Red
    $s2Details["error"] = $_.ToString()
} finally {
    Stop-FixtureProcessSafely -Proc $proc2 -CdpPort $Port
}

$results.Add([PSCustomObject]@{
    name = "fail_retry_exit0"
    passed = $s2Passed
    details = $s2Details
})
if (-not $s2Passed) { $allPassed = $false }

# ---------------------------------------------------------------------------
# 场景 3: never-resolve flush -> 5s timeout -> cancel -> No (超时处理)
# ---------------------------------------------------------------------------
Write-Host "`n------------------------------------------------------------" -ForegroundColor Cyan
Write-Host " 执行场景 3: never-resolve flush -> 5s timeout -> cancel -> No (验证超时弹窗与恢复)" -ForegroundColor Cyan
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan

$proc3 = $null
$s3Passed = $false
$s3Details = @{}

try {
    $proc3 = Start-FixtureProcess -ExeFilePath $canonicalExe -CdpPort $Port
    Wait-CdpReady -CdpPort $Port
    $mainHwnd = Find-ProcessMainWindow -TargetPid $proc3.Id
    if ($mainHwnd -eq [IntPtr]::Zero) { throw "未找到主窗口 HWND" }

    # CDP: 先 freeze 原始 bridge，再注入永远挂起的 flush (new Promise(() => {}))
    Write-Host "  [CDP 注入] 冻结并注入挂起 flush (new Promise(() => {}))..."
    $injectStall = @"
    (async () => {
        window.__VALIDATION_ORIGINAL__ = window.__VALIDATION_ORIGINAL__ || window.__ASHFALL_BRIDGE__;
        const orig = window.__VALIDATION_ORIGINAL__;
        if (orig && typeof orig.freeze === 'function') {
            await orig.freeze();
        }
        window.__ASHFALL_BRIDGE__ = {
            freeze: async () => {},
            thaw: () => {},
            isDirty: () => true,
            getRevision: () => (orig && typeof orig.getRevision === 'function') ? orig.getRevision() : 0,
            flush: () => new Promise(() => {}) // 永远挂起
        };
        return { stallInjected: true };
    })()
"@
    Invoke-CdpExpression -JsCode $injectStall -CdpPort $Port | Out-Null

    $tClose = [DateTime]::UtcNow
    Write-Host "  [发送 WM_CLOSE] 触发关闭，计时 5 秒后端超时..."
    [NativeWin32]::PostMessage($mainHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null

    # 等待对话框 1 (应在名义 5 秒超时后弹出)
    $dlg1 = Find-NativeDialog -TargetPid $proc3.Id -TimeoutSeconds 20.0
    if (-not $dlg1) { throw "超时未弹出重试对话框" }
    $elapsedSec = ([DateTime]::UtcNow - $tClose).TotalSeconds
    $s3Details["timeout_elapsed_seconds"] = [Math]::Round($elapsedSec, 2)
    $defBtn1 = Get-DialogDefaultButtonId -DialogHwnd $dlg1.Hwnd
    $s3Details["dialog1_default_button"] = $defBtn1
    Write-Host "  [原生对话框 1] 耗时 ${elapsedSec} 秒后捕获超时弹窗，默认按钮ID=$defBtn1"

    # 点击 Cancel (ID 2)
    Send-DialogButtonClick -DialogHwnd $dlg1.Hwnd -ButtonId $IDCANCEL

    # 等待对话框 2 (Yes / No)
    $dlg2 = Find-NativeDialog -TargetPid $proc3.Id -TimeoutSeconds 10.0
    if (-not $dlg2) { throw "未在超时内检测到确认放弃对话框" }
    $defBtn2 = Get-DialogDefaultButtonId -DialogHwnd $dlg2.Hwnd
    $s3Details["dialog2_default_button"] = $defBtn2
    Write-Host "  [原生对话框 2] 捕获二次确认放弃弹窗，默认按钮ID=$defBtn2"

    # 点击 No (ID 7) - 取消退出
    Send-DialogButtonClick -DialogHwnd $dlg2.Hwnd -ButtonId $IDNO

    Start-Sleep -Milliseconds 500

    # 恢复原始 bridge 以免悬挂 promise 干扰后续
    Invoke-CdpExpression -JsCode "(async () => { if (window.__VALIDATION_ORIGINAL__) { window.__ASHFALL_BRIDGE__ = window.__VALIDATION_ORIGINAL__; } })()" -CdpPort $Port | Out-Null

    $procAlive = (-not $proc3.HasExited)
    $hasOverlay = Invoke-CdpExpression -JsCode "!!document.getElementById('__ashfall_close_overlay__')" -CdpPort $Port
    $s3Details["window_alive"] = $procAlive
    $s3Details["overlay_removed"] = (-not $hasOverlay)

    # 严密判定：超时时间必须严格落在 [4.5s, 9.0s] 区间内，且默认按钮必须是 IDCANCEL(2) 与 IDNO(7)
    $timeoutInBounds = ($elapsedSec -ge 4.5 -and $elapsedSec -le 9.0)
    $s3Details["timeout_in_bounds"] = $timeoutInBounds

    if ($timeoutInBounds -and ($defBtn1 -eq $IDCANCEL) -and ($defBtn2 -eq $IDNO) -and $procAlive -and (-not $hasOverlay)) {
        $s3Passed = $true
        Write-Host "  [场景 3 验证通过] 5 秒超时正确触发(耗时${elapsedSec}s在[4.5, 9.0]内)，双弹窗默认按钮(2/7)符合规范，取消后解冻并保持窗口" -ForegroundColor Green
    } else {
        Write-Host "  [场景 3 验证失败] 详细状态: $($s3Details | ConvertTo-Json -Compress)" -ForegroundColor Red
    }
} catch {
    Write-Host "  [场景 3 异常]: $_" -ForegroundColor Red
    $s3Details["error"] = $_.ToString()
} finally {
    Stop-FixtureProcessSafely -Proc $proc3 -CdpPort $Port
}

$results.Add([PSCustomObject]@{
    name = "never_resolve_timeout"
    passed = $s3Passed
    details = $s3Details
})
if (-not $s3Passed) { $allPassed = $false }

# ---------------------------------------------------------------------------
# 场景 4: explicit discard -> exit (明确放弃未保存数据退出，脏标记不得落盘)
# ---------------------------------------------------------------------------
Write-Host "`n------------------------------------------------------------" -ForegroundColor Cyan
Write-Host " 执行场景 4: explicit discard -> exit (验证明确放弃未保存进度且不得落盘)" -ForegroundColor Cyan
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan

$proc4 = $null
$s4Passed = $false
$s4Details = @{}
$discardUuid = [Guid]::NewGuid().ToString("N")
$discardMarker = "DISCARD_PROBE_MARKER_$discardUuid"

try {
    # 验证前置条件：运行前磁盘 save.json 绝对不包含该 unique marker
    if (Test-Path -PathType Leaf $saveJsonPath) {
        $initialSave = Get-Content $saveJsonPath -Raw -Encoding UTF8
        if ($initialSave -like "*$discardMarker*") {
            throw "前置测试异常: 磁盘上已存在本次生成的唯一 discard marker!"
        }
    }

    $proc4 = Start-FixtureProcess -ExeFilePath $canonicalExe -CdpPort $Port
    Wait-CdpReady -CdpPort $Port
    $mainHwnd = Find-ProcessMainWindow -TargetPid $proc4.Id
    if ($mainHwnd -eq [IntPtr]::Zero) { throw "未找到主窗口 HWND" }

    # CDP: 先 freeze 原始 bridge，再注入失败与待丢弃 unique 标记
    $injectCode4 = @"
    (async () => {
        window.__VALIDATION_ORIGINAL__ = window.__VALIDATION_ORIGINAL__ || window.__ASHFALL_BRIDGE__;
        const orig = window.__VALIDATION_ORIGINAL__;
        if (orig && typeof orig.freeze === 'function') {
            await orig.freeze();
        }
        localStorage.setItem('probe-discard-key', '$discardMarker');
        let isDirty = true;
        window.__ASHFALL_BRIDGE__ = {
            freeze: async () => {},
            thaw: () => {},
            isDirty: () => isDirty,
            getRevision: () => (orig && typeof orig.getRevision === 'function') ? orig.getRevision() : 0,
            flush: async () => { throw new Error("场景4注入保存失败"); }
        };
        return { injected: true };
    })()
"@
    Invoke-CdpExpression -JsCode $injectCode4 -CdpPort $Port | Out-Null

    # 发送关闭请求
    [NativeWin32]::PostMessage($mainHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null

    # 对话框 1: 验证默认按钮为 IDCANCEL(2)，点击 Cancel
    $dlg1 = Find-NativeDialog -TargetPid $proc4.Id -TimeoutSeconds 15.0
    if (-not $dlg1) { throw "未在超时内检测到重试对话框" }
    $defBtn1 = Get-DialogDefaultButtonId -DialogHwnd $dlg1.Hwnd
    $s4Details["dialog1_default_button"] = $defBtn1
    Send-DialogButtonClick -DialogHwnd $dlg1.Hwnd -ButtonId $IDCANCEL

    # 对话框 2: 验证默认按钮为 IDNO(7)，点击 Yes (ID 6) - 明确确认放弃未保存数据退出
    $dlg2 = Find-NativeDialog -TargetPid $proc4.Id -TimeoutSeconds 10.0
    if (-not $dlg2) { throw "未在超时内检测到确认放弃对话框" }
    $defBtn2 = Get-DialogDefaultButtonId -DialogHwnd $dlg2.Hwnd
    $s4Details["dialog2_default_button"] = $defBtn2
    Write-Host "  [操作] 发送 IDYES ($IDYES) 明确放弃进度并退出..."
    Send-DialogButtonClick -DialogHwnd $dlg2.Hwnd -ButtonId $IDYES

    # 等待进程退出
    $exited = $proc4.WaitForExit(10000)
    $s4Details["has_exited"] = $exited

    # 验证磁盘存档：discardMarker 绝不得出现在 save.json 中
    $markerLeaked = $false
    if (Test-Path -PathType Leaf $saveJsonPath) {
        $rawSave = Get-Content $saveJsonPath -Raw -Encoding UTF8
        if ($rawSave -like "*$discardMarker*") {
            $markerLeaked = $true
        }
    }
    $s4Details["marker_leaked_to_disk"] = $markerLeaked

    if ($exited -and ($defBtn1 -eq $IDCANCEL) -and ($defBtn2 -eq $IDNO) -and (-not $markerLeaked)) {
        $s4Passed = $true
        Write-Host "  [场景 4 验证通过] 默认按钮(2/7)校验通过，进程退出，丢弃的唯一脏标记绝未写入磁盘 save.json" -ForegroundColor Green
    } else {
        Write-Host "  [场景 4 验证失败] 详细状态: $($s4Details | ConvertTo-Json -Compress)" -ForegroundColor Red
    }
} catch {
    Write-Host "  [场景 4 异常]: $_" -ForegroundColor Red
    $s4Details["error"] = $_.ToString()
} finally {
    Stop-FixtureProcessSafely -Proc $proc4 -CdpPort $Port
}

$results.Add([PSCustomObject]@{
    name = "explicit_discard"
    passed = $s4Passed
    details = $s4Details
})
if (-not $s4Passed) { $allPassed = $false }

# ---------------------------------------------------------------------------
# 6. 生成汇总报告 (Summary Report)
# ---------------------------------------------------------------------------
$finalReport = @{
    timestamp = (Get-Date).ToString("o")
    exePath = $canonicalExe
    allPassed = $allPassed
    scenarios = $results
}

$finalReportJson = $finalReport | ConvertTo-Json -Depth 6
$finalReportJson | Set-Content $reportPath -Encoding UTF8

Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host " 故障验收测试报告已写入: $reportPath" -ForegroundColor Cyan
Write-Host " 整体结果: $(if ($allPassed) { '全部通过' } else { '存在未通过场景' })" -ForegroundColor $(if ($allPassed) { 'Green' } else { 'Red' })
Write-Host "============================================================" -ForegroundColor Cyan

if (-not $allPassed) {
    exit 1
}
exit 0
