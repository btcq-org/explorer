/**
 * Thin wrapper around the dedicated Vultisig QBTC dApp provider
 * (`window.vultisig.qbtc`) introduced in vultisig-windows PR #3933.
 *
 * QBTC signs with ML-DSA-44, which doesn't fit the Keplr provider shape
 * (algo field, signature length, sign-doc encoding). The Vultisig extension
 * therefore exposes a QBTC-native surface with `request_accounts`,
 * `get_accounts`, `send_transaction`, `get_transaction_by_hash`.
 *
 * Lives in its own file so the upstream `ping-pub/explorer` merge surface
 * stays minimal.
 */

export type QbtcRequestMethod =
  | 'request_accounts'
  | 'get_accounts'
  | 'send_transaction'
  | 'sign_and_broadcast'
  | 'get_transaction_by_hash';

export interface QbtcProvider {
  request(args: { method: QbtcRequestMethod; params?: unknown[] }): Promise<any>;
}

export interface QbtcSendTxParams {
  from: string;
  to: string;
  value: string;
  memo?: string;
}

export interface QbtcCosmosMessage {
  typeUrl: string;
  value: Record<string, any>;
}

export interface QbtcCoin {
  denom: string;
  amount: string;
}

// Optional fee/gas override accepted by the provider's `sign_and_broadcast`.
// `gas` is the gas_limit as a string; `amount` is the fee coins. When omitted,
// the extension falls back to its hardcoded default (gas 300000, fee 800),
// which is too low for the large ML-DSA-44 signature on staking/gov messages.
export interface QbtcFee {
  amount: QbtcCoin[];
  gas: string;
}

export interface QbtcSignAndBroadcastParams {
  from: string;
  messages: QbtcCosmosMessage[];
  memo?: string;
  fee?: QbtcFee;
}

// QBTC's bond/fee denom and the chain-enforced flat minimum tx fee.
export const QBTC_FEE_DENOM = 'qbtc';
export const QBTC_MIN_FEE_AMOUNT = '800';

// The extension defaults gas_limit to 300000, but a MsgDelegate signed with
// ML-DSA-44 consumes ~301k+ (the signature is multi-KB → high WritePerByte
// gas), so a delegate tx runs out of gas. Request a comfortable ceiling; the
// flat min fee (800) is unaffected by the gas_limit on this chain.
export const QBTC_SIGN_GAS_LIMIT = '500000';

export function qbtcDefaultFee(gas: string = QBTC_SIGN_GAS_LIMIT): QbtcFee {
  return { amount: [{ denom: QBTC_FEE_DENOM, amount: QBTC_MIN_FEE_AMOUNT }], gas };
}

// EIP-1193 error codes used by the QBTC provider.
export const QBTC_ERR_USER_REJECTED = 4001;
export const QBTC_ERR_UNAUTHORIZED = 4100; // most commonly: vault has no MLDSA key

export function getQbtcProvider(): QbtcProvider | undefined {
  const vultisig = (window as any).vultisig;
  return vultisig?.qbtc as QbtcProvider | undefined;
}

export function isQbtcProviderAvailable(): boolean {
  return !!getQbtcProvider();
}

/**
 * The Vultisig extension keeps the dApp authorized after a manual
 * disconnect, so `get_accounts` would silently re-connect on the next page
 * load. We can't revoke that grant from here (the provider exposes no
 * disconnect method), so we persist a sticky flag: set on manual disconnect,
 * cleared on an explicit re-connect. `restoreQbtcSilently` honors it.
 */
const QBTC_DISCONNECT_KEY = 'qbtc-manual-disconnect';

export function markQbtcDisconnected(): void {
  localStorage.setItem(QBTC_DISCONNECT_KEY, '1');
}

export function clearQbtcDisconnected(): void {
  localStorage.removeItem(QBTC_DISCONNECT_KEY);
}

export function isQbtcManuallyDisconnected(): boolean {
  return localStorage.getItem(QBTC_DISCONNECT_KEY) === '1';
}

/**
 * Open the Vultisig grant-access popup and return the connected QBTC bech32
 * address. Throws an `EIP1193`-style error with `.code`:
 *   - 4001 if the user rejects the popup
 *   - 4100 if the active vault doesn't carry an ML-DSA public key
 */
export async function requestQbtcAccount(): Promise<string> {
  const provider = getQbtcProvider();
  if (!provider) {
    throw new Error('Vultisig QBTC provider not available');
  }
  const accounts: string[] = await provider.request({ method: 'request_accounts' });
  const address = accounts?.[0];
  if (!address) {
    throw new Error('No QBTC account returned by Vultisig');
  }
  return address;
}

/**
 * Silent: returns the currently authorized QBTC address, or empty string if
 * the dApp isn't connected. Does NOT open the popup.
 */
export async function getAuthorizedQbtcAccount(): Promise<string> {
  const provider = getQbtcProvider();
  if (!provider) return '';
  try {
    const accounts: string[] = await provider.request({ method: 'get_accounts' });
    return accounts?.[0] ?? '';
  } catch {
    return '';
  }
}

export async function sendQbtcTransaction(params: QbtcSendTxParams): Promise<string> {
  const provider = getQbtcProvider();
  if (!provider) {
    throw new Error('Vultisig QBTC provider not available');
  }
  return provider.request({ method: 'send_transaction', params: [params] });
}

/**
 * Generic message signer. Use this for anything beyond a bank send:
 * `MsgVote`, `MsgDelegate`, `MsgWithdrawDelegatorReward`, `MsgDeposit`, etc.
 * Vultisig pops its approval UI, signs the tx with ML-DSA-44, broadcasts,
 * and resolves with the tx hash.
 */
export async function signAndBroadcastQbtc(
  params: QbtcSignAndBroadcastParams,
): Promise<string> {
  const provider = getQbtcProvider();
  if (!provider) {
    throw new Error('Vultisig QBTC provider not available');
  }
  return provider.request({ method: 'sign_and_broadcast', params: [params] });
}

export function describeQbtcError(err: unknown): string {
  const e = err as { code?: number; message?: string } | undefined;
  if (e?.code === QBTC_ERR_USER_REJECTED) return 'Connection rejected.';
  // Override the provider's own 4100 message (it points to the obsolete
  // "Developer Options" toggle) with the current path in Vultisig.
  if (e?.code === QBTC_ERR_UNAUTHORIZED) {
    return 'QBTC requires a post-quantum (MLDSA) key on this vault. Enable it in Vault Settings, or choose another vault.';
  }
  return e?.message || 'Failed to connect Vultisig QBTC.';
}
