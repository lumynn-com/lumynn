export type RuntimeTransport = "http" | "https";

export const runtimeState: {
  transport: RuntimeTransport;
  httpsDisabledReason?: string;
} = {
  transport: "http"
};

export function setRuntimeTransport(transport: RuntimeTransport, httpsDisabledReason?: string): void {
  runtimeState.transport = transport;
  runtimeState.httpsDisabledReason = httpsDisabledReason;
}
