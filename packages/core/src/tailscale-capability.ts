/**
 * Tailscale network capability (PR 57 — private-phone-pairing).
 *
 * "Phone access requires both private-network reachability and valid application
 * session" — this is the private-network-reachability half: whether this host is
 * currently connected to a tailnet, and whether that tailnet supports HTTPS
 * certificate issuance for this host's own `*.ts.net` name (Tailscale's built-in
 * MagicDNS + cert feature). Pure data — the adapter that produces it lives in
 * `@minions/adapters` (needs `node:child_process` to query the real `tailscaled`).
 */
export type TailscaleCapability = Readonly<{
  /** Whether the local `tailscaled` backend reports a running, connected state. */
  readonly connected: boolean;
  /** This host's tailnet DNS name (e.g. `mini-1.example.ts.net`), when connected. */
  readonly tailnetHostname: string | undefined;
  /** Whether the tailnet has HTTPS certificate issuance enabled for this host. */
  readonly httpsCapable: boolean;
  /** The exact domain an HTTPS cert would be issued for, when `httpsCapable`. */
  readonly certDomain: string | undefined;
}>;
