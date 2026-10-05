import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * SSH 远程隧道（autossh 保活）的本机配置。
 *
 * 刻意独立于 ai_config_store：隧道参数是本机专属信息（SSH 主机、私钥路径等），
 * 既不需要随「导出配置」流转，也避免给既有配置结构引入未定义字段。
 */
export type SshTunnelConfig = {
    enabled: boolean;
    /** SSH 跳板 / 目标主机，例如 ssh.example.com。 */
    sshHost: string;
    sshPort: string;
    sshUser: string;
    /** 私钥路径；留空表示使用 ssh-agent 或默认密钥。 */
    identityFile: string;
    /** 本机监听端口（隧道入口）。 */
    localPort: string;
    /** 远端目标（相对 SSH 主机而言）主机与端口，通常就是远端 API 服务。 */
    targetHost: string;
    targetPort: string;
    /** 保活心跳间隔（秒），对应 ssh 的 ServerAliveInterval。 */
    keepAliveInterval: string;
    /** 心跳失败阈值（次），对应 ServerAliveCountMax。 */
    keepAliveCountMax: string;
    /** 连接退出后的重连间隔（秒）。 */
    retryDelay: string;
    /** 生成脚本时附带开机自启（Windows 计划任务）。 */
    autoStart: boolean;
};

export const SSH_TUNNEL_STORE_KEY = "infinite-canvas:ssh_tunnel_store";

export const defaultSshTunnelConfig: SshTunnelConfig = {
    enabled: false,
    sshHost: "",
    sshPort: "22",
    sshUser: "",
    identityFile: "",
    localPort: "18787",
    targetHost: "127.0.0.1",
    targetPort: "8000",
    keepAliveInterval: "30",
    keepAliveCountMax: "3",
    retryDelay: "5",
    autoStart: false,
};

type SshTunnelStore = {
    tunnel: SshTunnelConfig;
    updateTunnel: <K extends keyof SshTunnelConfig>(key: K, value: SshTunnelConfig[K]) => void;
    resetTunnel: () => void;
};

export const useSshTunnelStore = create<SshTunnelStore>()(
    persist(
        (set) => ({
            tunnel: defaultSshTunnelConfig,
            updateTunnel: (key, value) =>
                set((state) => ({
                    tunnel: { ...state.tunnel, [key]: value },
                })),
            resetTunnel: () => set({ tunnel: defaultSshTunnelConfig }),
        }),
        {
            name: SSH_TUNNEL_STORE_KEY,
            partialize: (state) => ({ tunnel: state.tunnel }),
            // 老数据 / 缺字段时逐项回落到默认值，避免出现 undefined。
            merge: (persisted, current) => {
                const persistedTunnel = ((persisted || {}) as Partial<SshTunnelStore>).tunnel || {};
                return { ...current, tunnel: { ...defaultSshTunnelConfig, ...persistedTunnel } };
            },
        },
    ),
);
