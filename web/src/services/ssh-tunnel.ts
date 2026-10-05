import { defaultSshTunnelConfig, type SshTunnelConfig } from "@/stores/use-ssh-tunnel-store";

/**
 * SSH 远程隧道的参数校验、命令预览与「保活自动化脚本」生成。
 *
 * 生成的脚本一律遵循同一条保活策略：
 *   1) 优先使用 autossh（AUTOSSH_GATETIME=0 + -M 0，心跳交给 ssh 的 ServerAlive）；
 *   2) 机器上没有 autossh 时，自动退化为 ssh 监督循环（进程退出即按间隔重连）；
 *   3) 无论哪条路径都带 ServerAliveInterval / ServerAliveCountMax / TCPKeepAlive /
 *      ExitOnForwardFailure，避免「隧道进程还在但转发已死」的假在线。
 */

export type SshTunnelFieldError =
    | "sshHost"
    | "sshUser"
    | "sshPort"
    | "localPort"
    | "targetHost"
    | "targetPort"
    | "keepAliveInterval"
    | "keepAliveCountMax"
    | "retryDelay";

function numeric(value: string) {
    const parsed = Number(String(value ?? "").trim());
    return Number.isFinite(parsed) ? parsed : NaN;
}

function validPort(value: string) {
    const parsed = numeric(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535;
}

function positiveInt(value: string, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = numeric(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

/** 校验隧道配置，返回不合法的字段列表（空数组表示可用）。 */
export function validateSshTunnelConfig(config: SshTunnelConfig): SshTunnelFieldError[] {
    const errors: SshTunnelFieldError[] = [];
    if (!config.sshHost.trim()) errors.push("sshHost");
    if (!config.sshUser.trim()) errors.push("sshUser");
    if (!validPort(config.sshPort)) errors.push("sshPort");
    if (!validPort(config.localPort)) errors.push("localPort");
    if (!config.targetHost.trim()) errors.push("targetHost");
    if (!validPort(config.targetPort)) errors.push("targetPort");
    if (!positiveInt(config.keepAliveInterval, 1, 3600)) errors.push("keepAliveInterval");
    if (!positiveInt(config.keepAliveCountMax, 1, 100)) errors.push("keepAliveCountMax");
    if (!positiveInt(config.retryDelay, 1, 3600)) errors.push("retryDelay");
    return errors;
}

export function resolveSshTunnelConfig(config?: Partial<SshTunnelConfig> | null): SshTunnelConfig {
    return { ...defaultSshTunnelConfig, ...(config || {}) };
}

export function sshTunnelForwardSpec(config: SshTunnelConfig) {
    return `${config.localPort.trim()}:${config.targetHost.trim()}:${config.targetPort.trim()}`;
}

export function sshTunnelRemoteSpec(config: SshTunnelConfig) {
    return `${config.sshUser.trim()}@${config.sshHost.trim()}`;
}

export function sshTunnelLocalUrl(config: SshTunnelConfig) {
    return `http://127.0.0.1:${config.localPort.trim()}`;
}

/** 终端验证命令：用于浏览器探测受限时人工核对隧道端口。 */
export function sshTunnelVerifyCommand(config: SshTunnelConfig) {
    return `curl -sS -o /dev/null -w "%{http_code}\\n" ${sshTunnelLocalUrl(config)}/`;
}

function keepAliveOptions(config: SshTunnelConfig) {
    return [
        "-o ExitOnForwardFailure=yes",
        `-o ServerAliveInterval=${config.keepAliveInterval.trim()}`,
        `-o ServerAliveCountMax=${config.keepAliveCountMax.trim()}`,
        "-o TCPKeepAlive=yes",
        "-o ConnectTimeout=10",
        "-o StrictHostKeyChecking=accept-new",
    ];
}

/** 复制给用户的等价命令（autossh 形态，单行）。 */
export function sshTunnelPreviewCommand(config: SshTunnelConfig) {
    const identity = config.identityFile.trim() ? `-i "${config.identityFile.trim()}" ` : "";
    return [
        "autossh -M 0 -N -T",
        ...keepAliveOptions(config),
        `-p ${config.sshPort.trim()}`,
        `-L ${sshTunnelForwardSpec(config)}`,
        `${identity}${sshTunnelRemoteSpec(config)}`,
    ].join(" ");
}

/** PowerShell 单引号字符串转义。 */
function psQuote(value: string) {
    return value.replace(/'/g, "''");
}

/**
 * Windows PowerShell 5.1 读取「无 BOM 的 UTF-8」脚本时会按本地 ANSI(GBK) 解码，
 * 中文注释里的多字节字符会吞掉紧随其后的引号，导致脚本语法崩坏。
 * 因此 .ps1 必须带 UTF-8 BOM。
 */
const UTF8_BOM = "\uFEFF";

/** 生成可下载的脚本文件（含必要编码处理）：ps1 带 BOM，sh 为纯 UTF-8。 */
export function buildSshTunnelScriptFile(kind: "ps1" | "sh", config: SshTunnelConfig) {
    if (kind === "ps1") {
        return { name: "infinite-canvas-ssh-tunnel.ps1", content: UTF8_BOM + buildSshTunnelPowerShellScript(config) };
    }
    return { name: "infinite-canvas-ssh-tunnel.sh", content: buildSshTunnelShellScript(config) };
}

/** 生成 Windows（PowerShell 5.1+）自动化脚本：autossh 优先 + 监督循环 + 可选开机自启。 */
export function buildSshTunnelPowerShellScript(config: SshTunnelConfig) {
    const identity = config.identityFile.trim();
    const lines = [
        "# ===== Infinite Canvas · SSH 远程隧道（autossh 保活） =====",
        "# 由「配置与用户偏好 → 本地代理 → SSH 远程连接」生成；改动参数后请重新下载本脚本。",
        "# 保活策略：优先 autossh；未安装时自动退化为 ssh 监督循环（断线按间隔重连）。",
        "# 如需 autossh 本体，可经包管理器安装（例如 MSYS2: pacman -S autossh）；不装也能用本脚本的兜底循环。",
        "#",
        "# 用法：",
        "#   powershell -ExecutionPolicy Bypass -File .\\infinite-canvas-ssh-tunnel.ps1              前台运行",
        "#   powershell -ExecutionPolicy Bypass -File .\\infinite-canvas-ssh-tunnel.ps1 -Background   后台运行",
        "#   powershell -ExecutionPolicy Bypass -File .\\infinite-canvas-ssh-tunnel.ps1 -InstallTask  注册开机自启并立即启动",
        "#   powershell -ExecutionPolicy Bypass -File .\\infinite-canvas-ssh-tunnel.ps1 -Status       查看运行状态",
        "#   powershell -ExecutionPolicy Bypass -File .\\infinite-canvas-ssh-tunnel.ps1 -Stop         停止隧道",
        "#   powershell -ExecutionPolicy Bypass -File .\\infinite-canvas-ssh-tunnel.ps1 -Uninstall    停止并移除自启任务",
        "",
        "[CmdletBinding()]",
        "param(",
        "    [switch]$Background,",
        "    [switch]$InstallTask,",
        "    [switch]$Uninstall,",
        "    [switch]$Stop,",
        "    [switch]$Status",
        ")",
        "",
        '$ErrorActionPreference = "Stop"',
        "",
        "# ---- 隧道参数（生成时写入）----",
        `$SshHost           = '${psQuote(config.sshHost.trim())}'`,
        `$SshPort           = ${config.sshPort.trim()}`,
        `$SshUser           = '${psQuote(config.sshUser.trim())}'`,
        `$IdentityFile      = '${psQuote(identity)}'   # 留空 = 使用 ssh-agent 或默认密钥`,
        `$LocalPort         = ${config.localPort.trim()}`,
        `$TargetHost        = '${psQuote(config.targetHost.trim())}'`,
        `$TargetPort        = ${config.targetPort.trim()}`,
        `$KeepAliveSeconds  = ${config.keepAliveInterval.trim()}`,
        `$KeepAliveCount    = ${config.keepAliveCountMax.trim()}`,
        `$RetryDelaySeconds = ${config.retryDelay.trim()}`,
        "",
        "$TaskName   = 'InfiniteCanvas-SshTunnel'",
        "$WorkDir    = Join-Path $env:LOCALAPPDATA 'infinite-canvas\\ssh-tunnel'",
        "$LogFile    = Join-Path $WorkDir 'tunnel.log'",
        "$PidFile    = Join-Path $WorkDir 'tunnel.pid'",
        "$ScriptPath = $MyInvocation.MyCommand.Path",
        "",
        "function Write-TunnelLog([string]$Message) {",
        "    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'",
        "    Add-Content -Path $LogFile -Value ('[{0}] {1}' -f $stamp, $Message) -Encoding UTF8",
        "}",
        "",
        "function Resolve-SshExe {",
        "    $command = Get-Command ssh.exe -ErrorAction SilentlyContinue",
        "    if ($command) { return $command.Source }",
        "    $fallback = Join-Path $env:SystemRoot 'System32\\OpenSSH\\ssh.exe'",
        "    if (Test-Path $fallback) { return $fallback }",
        "    throw '未找到 ssh.exe：请安装 Windows OpenSSH 客户端（设置 → 系统 → 可选功能）。'",
        "}",
        "",
        "function Resolve-AutoSshExe {",
        "    $command = Get-Command autossh -ErrorAction SilentlyContinue",
        "    if ($command) { return $command.Source }",
        "    return $null",
        "}",
        "",
        "function Build-SshArgs {",
        "    $list = @('-N', '-T',",
        "              '-o', 'ExitOnForwardFailure=yes',",
        "              '-o', ('ServerAliveInterval={0}' -f $KeepAliveSeconds),",
        "              '-o', ('ServerAliveCountMax={0}' -f $KeepAliveCount),",
        "              '-o', 'TCPKeepAlive=yes',",
        "              '-o', 'ConnectTimeout=10',",
        "              '-o', 'StrictHostKeyChecking=accept-new',",
        "              '-p', $SshPort,",
        "              '-L', ('{0}:{1}:{2}' -f $LocalPort, $TargetHost, $TargetPort))",
        "    if ($IdentityFile) { $list += @('-i', $IdentityFile) }",
        "    $list += ('{0}@{1}' -f $SshUser, $SshHost)",
        "    return $list",
        "}",
        "",
        "function Start-TunnelLoop {",
        "    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null",
        "    Set-Content -Path $PidFile -Value $PID -Encoding ASCII",
        "    $ssh = Resolve-SshExe",
        "    $autossh = Resolve-AutoSshExe",
        "    if ($autossh) {",
        "        $env:AUTOSSH_GATETIME = '0'",
        "        $env:AUTOSSH_LOGLEVEL = '1'",
        "        Write-TunnelLog ('启动隧道（autossh）{0} -> 本机 {1} -> {2}:{3}' -f (\"$SshUser@$SshHost`:$SshPort\"), $LocalPort, $TargetHost, $TargetPort)",
        "    } else {",
        "        Write-TunnelLog ('未检测到 autossh，使用 ssh 监督循环（保活 + 断线重连）：{0} -> 本机 {1} -> {2}:{3}' -f (\"$SshUser@$SshHost`:$SshPort\"), $LocalPort, $TargetHost, $TargetPort)",
        "    }",
        "    while ($true) {",
        "        $sshArgs = Build-SshArgs",
        "        try {",
        "            if ($autossh) { & $autossh @sshArgs 2>&1 | Add-Content -Path $LogFile -Encoding UTF8 }",
        "            else { & $ssh @sshArgs 2>&1 | Add-Content -Path $LogFile -Encoding UTF8 }",
        "        } catch {",
        "            Write-TunnelLog ('隧道进程异常：{0}' -f $_.Exception.Message)",
        "        }",
        "        Write-TunnelLog ('连接已退出，{0}s 后重连…' -f $RetryDelaySeconds)",
        "        Start-Sleep -Seconds $RetryDelaySeconds",
        "    }",
        "}",
        "",
        "function Stop-TunnelProcess {",
        "    if (-not (Test-Path $PidFile)) { Write-TunnelLog '未发现 PID 文件，跳过停止。'; return }",
        "    $tunnelPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)",
        "    if ($tunnelPid) {",
        "        & taskkill /PID $tunnelPid /T /F 2>&1 | Out-Null",
        "        Write-TunnelLog ('已停止隧道进程树（PID {0}）。' -f $tunnelPid)",
        "    }",
        "    Remove-Item $PidFile -ErrorAction SilentlyContinue",
        "}",
        "",
        "function Show-TunnelStatus {",
        "    $alive = $false",
        "    if (Test-Path $PidFile) {",
        "        $tunnelPid = (Get-Content $PidFile | Select-Object -First 1)",
        "        $alive = [bool](Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)",
        "    }",
        "    $listening = $false",
        "    try { $listening = [bool](Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue) } catch { $listening = $false }",
        "    Write-Host ('隧道进程：{0}；本机 {1} 端口：{2}' -f $(if ($alive) { '运行中' } else { '未运行' }), $LocalPort, $(if ($listening) { '已监听' } else { '未监听' }))",
        "    Write-Host ('日志：{0}' -f $LogFile)",
        "}",
        "",
        "if ($Uninstall) { Stop-TunnelProcess; & schtasks /Delete /TN $TaskName /F 2>&1 | Out-Null; Write-Host '已移除开机自启任务。'; exit 0 }",
        "if ($Stop) { Stop-TunnelProcess; exit 0 }",
        "if ($Status) { Show-TunnelStatus; exit 0 }",
        "",
        "if ($InstallTask) {",
        "    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null",
        "    $action = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{0}\"' -f $ScriptPath",
        "    & schtasks /Create /TN $TaskName /SC ONLOGON /F /TR $action | Out-Null",
        "    & schtasks /Run /TN $TaskName | Out-Null",
        "    Write-Host '已注册开机自启并启动；停止/移除请使用 -Stop / -Uninstall。'",
        "    exit 0",
        "}",
        "",
        "if ($Background) {",
        "    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null",
        "    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) -WindowStyle Hidden",
        "    Write-Host '隧道已在后台启动。'",
        "    exit 0",
        "}",
        "",
        "Start-TunnelLoop",
        "",
    ];
    return lines.join("\n");
}

/** 生成 Linux / macOS 自动化脚本：autossh 优先 + 监督循环兜底 + nohup/systemd 持久化说明。 */
export function buildSshTunnelShellScript(config: SshTunnelConfig) {
    const identity = config.identityFile.trim();
    const lines = [
        "#!/usr/bin/env bash",
        "# ===== Infinite Canvas · SSH 远程隧道（autossh 保活） =====",
        "# 由「配置与用户偏好 → 本地代理 → SSH 远程连接」生成；改动参数后请重新下载本脚本。",
        "# 保活策略：优先 autossh（AUTOSSH_GATETIME=0 + -M 0，心跳交给 ssh 的 ServerAlive）；",
        "#           未安装 autossh 时自动退化为 ssh 监督循环（断线按间隔重连）。",
        "",
        "# 持久运行：",
        `#   nohup bash ./infinite-canvas-ssh-tunnel.sh >> "\${XDG_STATE_HOME:-$HOME/.local/state}/infinite-canvas/ssh-tunnel.log" 2>&1 &`,
        "#   或写入 systemd user 单元（~/.config/systemd/user/infinite-canvas-tunnel.service）：",
        "#     [Unit]",
        "#     Description=Infinite Canvas SSH tunnel",
        "#     After=network-online.target",
        "#     [Service]",
        `#     ExecStart=/usr/bin/bash ${"$HOME"}/infinite-canvas-ssh-tunnel.sh`,
        "#     Restart=always",
        "#     RestartSec=5",
        "#     [Install]",
        "#     WantedBy=default.target",
        "",
        "set -u",
        "",
        "# ---- 隧道参数（生成时写入）----",
        `SSH_HOST='${config.sshHost.trim()}'`,
        `SSH_PORT=${config.sshPort.trim()}`,
        `SSH_USER='${config.sshUser.trim()}'`,
        `IDENTITY_FILE='${identity}'   # 留空 = 使用 ssh-agent 或默认密钥`,
        `LOCAL_PORT=${config.localPort.trim()}`,
        `TARGET_HOST='${config.targetHost.trim()}'`,
        `TARGET_PORT=${config.targetPort.trim()}`,
        `KEEPALIVE_SECONDS=${config.keepAliveInterval.trim()}`,
        `KEEPALIVE_COUNT=${config.keepAliveCountMax.trim()}`,
        `RETRY_DELAY=${config.retryDelay.trim()}`,
        "",
        'LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/infinite-canvas"',
        'LOG_FILE="$LOG_DIR/ssh-tunnel.log"',
        'PID_FILE="$LOG_DIR/ssh-tunnel.pid"',
        'mkdir -p "$LOG_DIR"',
        'echo $$ > "$PID_FILE"',
        "",
        "SSH_ARGS=( -N -T \\",
        "  -o ExitOnForwardFailure=yes \\",
        '  -o "ServerAliveInterval=$KEEPALIVE_SECONDS" \\',
        '  -o "ServerAliveCountMax=$KEEPALIVE_COUNT" \\',
        "  -o TCPKeepAlive=yes \\",
        "  -o ConnectTimeout=10 \\",
        "  -o StrictHostKeyChecking=accept-new \\",
        '  -p "$SSH_PORT" \\',
        '  -L "$LOCAL_PORT:$TARGET_HOST:$TARGET_PORT" )',
        'if [ -n "$IDENTITY_FILE" ]; then SSH_ARGS+=( -i "$IDENTITY_FILE" ); fi',
        'TARGET="$SSH_USER@$SSH_HOST"',
        "",
        "if command -v autossh >/dev/null 2>&1; then",
        "  export AUTOSSH_GATETIME=0",
        "  export AUTOSSH_LOGLEVEL=1",
        '  echo "[$(date \'+%F %T\')] 启动隧道（autossh）：$TARGET -> 本机 $LOCAL_PORT -> $TARGET_HOST:$TARGET_PORT" >> "$LOG_FILE"',
        '  exec autossh -M 0 "${SSH_ARGS[@]}" "$TARGET" >> "$LOG_FILE" 2>&1',
        "fi",
        "",
        'echo "[$(date \'+%F %T\')] 未检测到 autossh，使用 ssh 监督循环（保活 + 断线重连）" >> "$LOG_FILE"',
        "while :; do",
        '  ssh "${SSH_ARGS[@]}" "$TARGET" >> "$LOG_FILE" 2>&1',
        '  echo "[$(date \'+%F %T\')] 连接已退出，${RETRY_DELAY}s 后重连…" >> "$LOG_FILE"',
        '  sleep "$RETRY_DELAY"',
        "done",
        "",
    ];
    return lines.join("\n");
}

/**
 * 探测本机端口是否已被监听（隧道是否就绪）。
 * 使用 no-cors 模式：只要 TCP 能连通就视为在线，不受目标服务 CORS 策略影响。
 */
export async function probeLocalPort(port: string, timeoutMs = 3000): Promise<boolean> {
    const value = Number(String(port ?? "").trim());
    if (!Number.isInteger(value) || value <= 0 || value > 65535) return false;
    try {
        await fetch(`http://127.0.0.1:${value}/`, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
        return true;
    } catch {
        return false;
    }
}
