<script lang="ts" setup>
/**
 * QBTC-native replacement for the upstream `<ping-tx-dialog>`.
 *
 * The CDN widget's signer factory only knows Kepler / Leap / Metamask /
 * Ledger; calling Send with a QBTC wallet trips its `"No wallet connected"`
 * branch. QBTC also signs with ML-DSA-44, which Keplr's offline signer can't
 * produce. So we render a daisyUI modal here and route Send/Transfer to
 * `window.vultisig.qbtc.request({ method: 'send_transaction', ... })` and
 * Vote (plus future Delegate / Withdraw / Deposit) to the provider's
 * generic `sign_and_broadcast` method.
 *
 * Reuses the existing `<label for="send|transfer|vote">` open triggers by
 * mounting hidden `<input id="send|transfer|vote" type="checkbox">` toggles
 * with the daisyUI modal-toggle pattern. All QBTC divergence stays inside
 * this file so shared upstream pages don't need to change.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { fromBech32 } from '@cosmjs/encoding';
import { useBlockchain, useStakingStore, useTxDialog, useWalletStore } from '@/stores';
import {
  describeQbtcError,
  isQbtcProviderAvailable,
  qbtcDefaultFee,
  QBTC_SIGN_GAS_LIMIT,
  sendQbtcTransaction,
  signAndBroadcastQbtc,
} from '@/libs/vultisig-qbtc';
import router from '@/router';

type ModalMode = 'send' | 'transfer' | 'vote' | 'delegate' | 'withdraw';

const walletStore = useWalletStore();
const chainStore = useBlockchain();
const dialogStore = useTxDialog();
const stakingStore = useStakingStore();

// Send/Transfer go through `window.vultisig.qbtc`'s `send_transaction` (bank
// only). Vote, Delegate and Withdraw are wired to the same upstream
// `dialog.open(…)` entry points and submit via the provider's generic
// `sign_and_broadcast`.
const modes: ReadonlyArray<{ id: ModalMode; title: string; submitting: string }> = [
  { id: 'send', title: 'Send', submitting: 'Sending…' },
  { id: 'transfer', title: 'Transfer', submitting: 'Transferring…' },
  { id: 'vote', title: 'Vote', submitting: 'Voting…' },
  { id: 'delegate', title: 'Delegate', submitting: 'Delegating…' },
  { id: 'withdraw', title: 'Withdraw Reward', submitting: 'Withdrawing…' },
];

const mode = ref<ModalMode>('send');
const recipient = ref('');
const amountInput = ref('');
const memo = ref('');
const showAdvanced = ref(false);
const submitting = ref(false);
const errorMsg = ref('');
const txHash = ref('');

// Vote-specific state. Upstream encodes option as the gov.v1 enum int:
// 1=Yes, 2=Abstain, 3=No, 4=NoWithVeto.
const voteOption = ref<'1' | '2' | '3' | '4'>('1');

// Read proposal_id lazily from the dialog store. We can't capture it inside
// onToggleChange: the label's native checkbox toggle fires `change` before
// Vue runs the sibling `@click="dialog.open('vote', { proposal_id })"`, so
// the store is still stale at that moment. A computed re-reads on every
// access, so submit always sees the latest value.
const proposalId = computed(() => {
  try {
    const parsed = JSON.parse(dialogStore.params || '{}');
    return parsed.proposal_id != null ? String(parsed.proposal_id) : '';
  } catch {
    return '';
  }
});

// Delegate state. When opened from a validator page the operator address rides
// in on `params.validator_address`; from the account/dashboard page it arrives
// empty (`{}`) and the user picks one from the dropdown. Like `proposalId`,
// read the param via a computed so submit/render always see the latest store
// value (the label's native `change` fires before the sibling `dialog.open`).
const validatorFromParams = computed(() => {
  try {
    const parsed = JSON.parse(dialogStore.params || '{}');
    return parsed.validator_address ? String(parsed.validator_address) : '';
  } catch {
    return '';
  }
});

// User's dropdown choice when no validator was pre-supplied.
const validatorChoice = ref('');

const selectedValidator = computed(
  () => validatorFromParams.value || validatorChoice.value
);

const bondDenom = computed(() => stakingStore.params?.bond_denom || 'qbtc');

const validatorOptions = computed(() =>
  [...stakingStore.validators]
    .filter((v) => v.operator_address)
    .map((v) => ({
      address: v.operator_address,
      moniker: v.description?.moniker || v.operator_address,
    }))
);

const selectedValidatorMoniker = computed(() => {
  const match = validatorOptions.value.find(
    (v) => v.address === selectedValidator.value
  );
  return match?.moniker || selectedValidator.value;
});

// Withdraw rewards. A specific validator rides in on `params.validator_address`
// (dashboard / account rows); opened with empty params (account header) it
// claims from every active delegation in one tx. Read the param via a computed
// for the same staleness reason as `proposalId`/`validatorFromParams`.
const withdrawValidators = computed(() => {
  if (validatorFromParams.value) return [validatorFromParams.value];
  return walletStore.delegations
    .map((d) => d.delegation.validator_address)
    .filter(Boolean);
});

// Distribution rewards are DecCoins — base-unit amounts carried with 18-digit
// fractional precision (e.g. "1500000000.000000000000000000"). Floor to whole
// base units before the integer base→QBTC conversion.
function formatRewardQbtc(decRaw: string): string {
  const intPart = (decRaw || '0').split('.')[0] || '0';
  return baseToDecimal(intPart);
}

const withdrawRewardLabel = computed(() => {
  const denom = bondDenom.value;
  if (validatorFromParams.value) {
    const entry = walletStore.rewards.rewards?.find(
      (r) => r.validator_address === validatorFromParams.value
    );
    const coin = entry?.reward?.find((c) => c.denom === denom);
    return `${formatRewardQbtc(coin?.amount ?? '0')} QBTC`;
  }
  const total = walletStore.rewards.total?.find((c) => c.denom === denom);
  return `${formatRewardQbtc(total?.amount ?? '0')} QBTC`;
});

const QBTC_DECIMALS = 8;
const QBTC_BASE = 10n ** BigInt(QBTC_DECIMALS);

function baseToDecimal(base: string): string {
  if (!/^\d+$/.test(base)) return '0';
  const b = BigInt(base);
  const whole = b / QBTC_BASE;
  const frac = b % QBTC_BASE;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(QBTC_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

function decimalToBase(decimal: string): string | null {
  if (!/^\d+(\.\d+)?$/.test(decimal)) return null;
  const [whole, frac = ''] = decimal.split('.');
  if (frac.length > QBTC_DECIMALS) return null;
  const padded = frac.padEnd(QBTC_DECIMALS, '0');
  const result = BigInt(whole) * QBTC_BASE + BigInt(padded);
  if (result === 0n) return null;
  return result.toString();
}

const qbtcBalance = computed(() => {
  return walletStore.balances.find((b) => b.denom === 'qbtc');
});

const balanceLabel = computed(() => {
  if (!qbtcBalance.value) return '0 QBTC';
  return `${baseToDecimal(qbtcBalance.value.amount)} QBTC`;
});

const activeModeMeta = computed(
  () => modes.find((m) => m.id === mode.value) ?? modes[0]
);

function isValidQbtcAddress(addr: string): boolean {
  try {
    const { prefix } = fromBech32(addr);
    return prefix === 'qbtc';
  } catch {
    return false;
  }
}

function closeModal() {
  const cb = document.getElementById(mode.value);
  if (cb instanceof HTMLInputElement) cb.checked = false;
}

function resetForm() {
  recipient.value = '';
  amountInput.value = '';
  memo.value = '';
  showAdvanced.value = false;
  errorMsg.value = '';
  txHash.value = '';
  submitting.value = false;
  voteOption.value = '1';
  validatorChoice.value = '';
}

// Reset every time a modal flips to open. Watching the store's `type`
// misses the case of opening the same modal twice in a row (value doesn't
// change), so we hook the daisyUI modal-toggle checkboxes directly.
function onToggleChange(e: Event) {
  const t = e.target as HTMLInputElement | null;
  if (!t || !t.checked) return;
  if (
    t.id === 'send' ||
    t.id === 'transfer' ||
    t.id === 'vote' ||
    t.id === 'delegate' ||
    t.id === 'withdraw'
  ) {
    mode.value = t.id;
    resetForm();
    // The delegate dropdown needs the active validator set; the withdraw modal
    // needs it for the validator moniker. On the account/dashboard page that
    // list may not be fetched yet; pull it lazily so the UI fills in reactively.
    if (
      (t.id === 'delegate' || t.id === 'withdraw') &&
      stakingStore.validators.length === 0
    ) {
      stakingStore.fetchAcitveValdiators();
    }
    // Withdraw-all enumerates the user's delegations and reads pending reward
    // amounts; make sure both are loaded.
    if (t.id === 'withdraw' && walletStore.delegations.length === 0) {
      walletStore.loadMyAsset();
    }
  }
}
onMounted(() => document.addEventListener('change', onToggleChange));
onUnmounted(() => document.removeEventListener('change', onToggleChange));

async function onSubmit() {
  errorMsg.value = '';
  const from = walletStore.currentAddress;
  if (!from) {
    errorMsg.value = 'Wallet not connected.';
    return;
  }
  if (!isQbtcProviderAvailable()) {
    errorMsg.value = 'Vultisig QBTC provider not available.';
    return;
  }

  if (mode.value === 'vote') {
    if (!proposalId.value) {
      errorMsg.value = 'Proposal id is empty.';
      return;
    }
    submitting.value = true;
    try {
      const hash: string = await signAndBroadcastQbtc({
        from,
        messages: [
          {
            typeUrl: '/cosmos.gov.v1.MsgVote',
            value: {
              voter: from,
              proposalId: proposalId.value,
              option: Number(voteOption.value),
            },
          },
        ],
        memo: memo.value.trim() || undefined,
        fee: qbtcDefaultFee(),
      });
      txHash.value = hash;
      confirmedEvent({ hash });
    } catch (e) {
      errorMsg.value = describeQbtcError(e);
    } finally {
      submitting.value = false;
    }
    return;
  }

  if (mode.value === 'delegate') {
    const validator = selectedValidator.value;
    if (!validator) {
      errorMsg.value = 'Select a validator.';
      return;
    }
    const baseUnits = decimalToBase(amountInput.value.trim());
    if (!baseUnits) {
      errorMsg.value = `Amount must be a positive QBTC value (up to ${QBTC_DECIMALS} decimal places).`;
      return;
    }
    submitting.value = true;
    try {
      const hash: string = await signAndBroadcastQbtc({
        from,
        messages: [
          {
            typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
            value: {
              delegatorAddress: from,
              validatorAddress: validator,
              amount: { denom: bondDenom.value, amount: baseUnits },
            },
          },
        ],
        memo: memo.value.trim() || undefined,
        fee: qbtcDefaultFee(),
      });
      txHash.value = hash;
      confirmedEvent({ hash });
    } catch (e) {
      errorMsg.value = describeQbtcError(e);
    } finally {
      submitting.value = false;
    }
    return;
  }

  if (mode.value === 'withdraw') {
    const validators = withdrawValidators.value;
    if (!validators.length) {
      errorMsg.value = 'No delegations to withdraw rewards from.';
      return;
    }
    submitting.value = true;
    try {
      // Gas scales with message count: the base ceiling covers the multi-KB
      // ML-DSA signature; each extra MsgWithdrawDelegatorReward adds a bit
      // more. The flat min fee (800) is independent of gas_limit on this
      // chain, so over-requesting gas is harmless.
      const gas = String(
        Number(QBTC_SIGN_GAS_LIMIT) + Math.max(0, validators.length - 1) * 200000
      );
      const hash: string = await signAndBroadcastQbtc({
        from,
        messages: validators.map((validatorAddress) => ({
          typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
          value: { delegatorAddress: from, validatorAddress },
        })),
        memo: memo.value.trim() || undefined,
        fee: qbtcDefaultFee(gas),
      });
      txHash.value = hash;
      confirmedEvent({ hash });
    } catch (e) {
      errorMsg.value = describeQbtcError(e);
    } finally {
      submitting.value = false;
    }
    return;
  }

  const to = recipient.value.trim();
  if (!isValidQbtcAddress(to)) {
    errorMsg.value = 'Recipient must be a valid qbtc1… address.';
    return;
  }
  const baseUnits = decimalToBase(amountInput.value.trim());
  if (!baseUnits) {
    errorMsg.value = `Amount must be a positive QBTC value (up to ${QBTC_DECIMALS} decimal places).`;
    return;
  }
  submitting.value = true;
  try {
    const hash: string = await sendQbtcTransaction({
      from,
      to,
      value: baseUnits,
      memo: memo.value.trim() || undefined,
    });
    txHash.value = hash;
    // Surface to upstream listeners (TxDialog forwards `confirmed` to the
    // store, which fires the page's refresh callback).
    confirmedEvent({ hash });
  } catch (e) {
    errorMsg.value = describeQbtcError(e);
  } finally {
    submitting.value = false;
  }
}

const emit = defineEmits<{
  (e: 'confirmed', payload: { detail: { hash: string } }): void;
}>();

function confirmedEvent(payload: { hash: string }) {
  emit('confirmed', { detail: { hash: payload.hash } });
}

function viewTx() {
  if (!txHash.value) return;
  closeModal();
  router.push({ path: `/${chainStore.chainName}/tx/${txHash.value}` });
}
</script>

<template>
  <Teleport to="body">
    <template v-for="m in modes" :key="m.id">
      <input type="checkbox" :id="m.id" class="modal-toggle" />
      <div class="modal qbtc-tx-modal">
        <div class="modal-box relative">
          <label
            :for="m.id"
            class="btn btn-sm btn-circle absolute right-2 top-2"
            >✕</label
          >
          <h3 class="font-bold text-lg">{{ m.title }}</h3>

          <div v-if="!txHash">
            <div class="form-control">
              <label class="label"><span class="label-text">Sender</span></label>
              <input
                type="text"
                class="input input-bordered bg-base-200 w-full"
                :value="walletStore.currentAddress"
                readonly
              />
            </div>

            <template v-if="m.id === 'vote'">
              <div class="form-control">
                <label class="label"
                  ><span class="label-text">Proposal</span></label
                >
                <input
                  type="text"
                  class="input input-bordered bg-base-200 w-full"
                  :value="proposalId ? `#${proposalId}` : ''"
                  readonly
                />
              </div>

              <div class="form-control">
                <label class="label"><span class="label-text">Option</span></label>
                <div class="qbtc-vote-options flex flex-wrap items-center gap-3">
                  <label class="cursor-pointer inline-flex items-center gap-2">
                    <input
                      v-model="voteOption"
                      type="radio"
                      value="1"
                      class="radio radio-sm radio-success"
                      :disabled="submitting"
                    />
                    <span class="label-text">Yes</span>
                  </label>
                  <label class="cursor-pointer inline-flex items-center gap-2">
                    <input
                      v-model="voteOption"
                      type="radio"
                      value="3"
                      class="radio radio-sm radio-error"
                      :disabled="submitting"
                    />
                    <span class="label-text">No</span>
                  </label>
                  <label class="cursor-pointer inline-flex items-center gap-2">
                    <input
                      v-model="voteOption"
                      type="radio"
                      value="4"
                      class="radio radio-sm radio-warning"
                      :disabled="submitting"
                    />
                    <span class="label-text">No With Veto</span>
                  </label>
                  <label class="cursor-pointer inline-flex items-center gap-2">
                    <input
                      v-model="voteOption"
                      type="radio"
                      value="2"
                      class="radio radio-sm"
                      :disabled="submitting"
                    />
                    <span class="label-text">Abstain</span>
                  </label>
                </div>
              </div>
            </template>

            <template v-else-if="m.id === 'withdraw'">
              <div v-if="validatorFromParams" class="form-control">
                <label class="label"
                  ><span class="label-text">Validator</span></label
                >
                <input
                  type="text"
                  class="input input-bordered bg-base-200 w-full"
                  :value="selectedValidatorMoniker"
                  readonly
                />
              </div>
              <div v-else class="form-control">
                <label class="label"
                  ><span class="label-text">Validators</span></label
                >
                <input
                  type="text"
                  class="input input-bordered bg-base-200 w-full"
                  :value="`${withdrawValidators.length} validator${
                    withdrawValidators.length === 1 ? '' : 's'
                  }`"
                  readonly
                />
              </div>

              <div class="form-control">
                <label class="label"
                  ><span class="label-text">Pending Reward</span></label
                >
                <input
                  type="text"
                  class="input input-bordered bg-base-200 w-full"
                  :value="withdrawRewardLabel"
                  readonly
                />
              </div>
            </template>

            <template v-else>
              <div class="form-control">
                <label class="label"
                  ><span class="label-text">Balances</span></label
                >
                <input
                  type="text"
                  class="input input-bordered bg-base-200 w-full"
                  :value="balanceLabel"
                  readonly
                />
              </div>

              <div v-if="m.id === 'delegate'" class="form-control">
                <label class="label"
                  ><span class="label-text">Validator</span></label
                >
                <input
                  v-if="validatorFromParams"
                  type="text"
                  class="input input-bordered bg-base-200 w-full"
                  :value="selectedValidatorMoniker"
                  readonly
                />
                <select
                  v-else
                  v-model="validatorChoice"
                  class="select select-bordered bg-base-200 w-full"
                  :disabled="submitting"
                >
                  <option value="" disabled>Select a validator</option>
                  <option
                    v-for="v in validatorOptions"
                    :key="v.address"
                    :value="v.address"
                  >
                    {{ v.moniker }}
                  </option>
                </select>
              </div>

              <div v-else class="form-control">
                <label class="label"
                  ><span class="label-text">Recipient</span></label
                >
                <input
                  v-model="recipient"
                  type="text"
                  placeholder="qbtc1…"
                  class="input input-bordered bg-base-200 w-full"
                  :disabled="submitting"
                />
              </div>

              <div class="form-control">
                <label class="label">
                  <span class="label-text">Amount</span>
                </label>
                <label
                  class="input input-bordered bg-base-200 w-full flex items-center gap-2"
                >
                  <input
                    v-model="amountInput"
                    type="text"
                    inputmode="decimal"
                    placeholder="0.0"
                    class="grow bg-transparent outline-none border-0 p-0"
                    :disabled="submitting"
                  />
                  <span
                    class="badge badge-ghost bg-base-300 border-0 uppercase"
                    >qbtc</span
                  >
                </label>
              </div>
            </template>

            <div class="form-control mt-2">
              <label class="cursor-pointer inline-flex items-center gap-2">
                <input
                  v-model="showAdvanced"
                  type="checkbox"
                  class="checkbox checkbox-xs rounded-full"
                />
                <span class="label-text">Advance</span>
              </label>
            </div>
            <div v-if="showAdvanced" class="form-control">
              <label class="label"><span class="label-text">Memo</span></label>
              <input
                v-model="memo"
                type="text"
                class="input input-bordered bg-base-200 w-full"
                :disabled="submitting"
              />
            </div>

            <div
              v-if="errorMsg"
              class="alert alert-error mt-3 text-sm py-2"
              style="overflow-wrap: anywhere"
            >
              <span>{{ errorMsg }}</span>
            </div>

            <div class="modal-action mt-4">
              <label
                :for="m.id"
                class="btn btn-ghost"
                :class="{ 'btn-disabled': submitting }"
                >Cancel</label
              >
              <button
                class="btn btn-primary"
                :disabled="submitting"
                @click="onSubmit"
              >
                <span
                  v-if="submitting"
                  class="loading loading-spinner loading-xs mr-1"
                ></span>
                {{ submitting ? activeModeMeta.submitting : activeModeMeta.title }}
              </button>
            </div>
          </div>

          <div v-else>
            <div class="alert alert-success text-sm py-2 mt-2">
              <span>Transaction submitted.</span>
            </div>
            <div class="form-control">
              <label class="label"><span class="label-text">Tx hash</span></label>
              <input
                type="text"
                class="input input-bordered bg-base-200 w-full"
                :value="txHash"
                readonly
              />
            </div>
            <div class="modal-action mt-4">
              <label :for="m.id" class="btn btn-ghost">Close</label>
              <button class="btn btn-primary" @click="viewTx">View</button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style>
/*
 * The @ping-pub/widget bundle injects its own tailwind+daisyUI build into
 * <head> at runtime (after our app CSS), which neutralizes our `.input`,
 * `bg-base-200`, etc. on this modal. Scope the modal styles under a unique
 * `.qbtc-tx-modal` ancestor so the cascade can't lose them.
 *
 * Not <style scoped> because Vue's scoped attribute selectors are weaker
 * than the widget's class selectors after CSSOM injection.
 */
.qbtc-tx-modal .modal-box {
  background-color: hsl(var(--b1));
  color: hsl(var(--bc));
}
.qbtc-tx-modal .modal-box .label {
  padding-top: 0.5rem;
  padding-bottom: 0.25rem;
}
.qbtc-tx-modal .modal-box .label-text {
  font-size: 0.875rem;
  color: hsl(var(--bc) / 0.7);
}
.qbtc-tx-modal .modal-box .label-text-alt {
  font-size: 0.75rem;
  color: hsl(var(--bc) / 0.6);
}
.qbtc-tx-modal .modal-box .input {
  height: 3rem;
  padding-left: 1rem;
  padding-right: 1rem;
  font-size: 0.875rem;
  line-height: 1.25rem;
  width: 100%;
  border-radius: 0.5rem;
  background-color: transparent;
  border: 1px solid hsl(var(--bc) / 0.15);
  color: hsl(var(--bc));
  outline: none;
}
.qbtc-tx-modal .modal-box .input:focus-within,
.qbtc-tx-modal .modal-box .input:focus {
  border-color: hsl(var(--p) / 0.6);
}
.qbtc-tx-modal .modal-box .input > input {
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  width: 100%;
  height: 100%;
  font-size: inherit;
  color: inherit;
}
.qbtc-tx-modal .modal-box .select {
  height: 3rem;
  min-height: 3rem;
  padding-left: 1rem;
  padding-right: 2.5rem;
  font-size: 0.875rem;
  line-height: 1.25rem;
  width: 100%;
  border-radius: 0.5rem;
  background-color: transparent;
  border: 1px solid hsl(var(--bc) / 0.15);
  color: hsl(var(--bc));
  outline: none;
}
.qbtc-tx-modal .modal-box .select:focus,
.qbtc-tx-modal .modal-box .select:focus-within {
  border-color: hsl(var(--p) / 0.6);
}
.qbtc-tx-modal .modal-box .badge {
  text-transform: uppercase;
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  background-color: hsl(var(--b3));
  border: 0;
  border-radius: 0.375rem;
}
</style>
