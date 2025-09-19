import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, Slice, toNano } from "@ton/core";
import { Op } from "./JettonConstants";
import { endParse } from "./JettonMinter";

export type JettonSwapConfig = {
  ownerAddress: Address;
  jwalletAddress: Address;
  jettonMasterAddress: Address;
  jettonBalance: bigint
};

export function jettonSwapConfigToCell(config: JettonSwapConfig): Cell {
  return beginCell().storeAddress(config.ownerAddress).storeAddress(config.jwalletAddress).storeAddress(config.jettonMasterAddress).storeCoins(0n).endCell();
}

export class JettonSwap implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static createFromAddress(address: Address) {
    return new JettonSwap(address);
  }

  static createFromConfig(config: JettonSwapConfig, code: Cell, workchain = 0) {
    const data = jettonSwapConfigToCell(config);
    const init = { code, data };
    return new JettonSwap(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  static changeJWalletAddrMessage(newJWalletAddress: Address, jettonBalance: bigint) {
    return beginCell()
      .storeUint(Op.change_jwallet_addr, 32)
      .storeUint(0, 64) // op, queryId
      .storeAddress(newJWalletAddress)
      .storeCoins(jettonBalance)
      .endCell();
  }

  async sendChangeJWalletAddr(provider: ContractProvider, via: Sender, newAddress: Address, jettonBalance: bigint) {
    await provider.internal(via, {
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: JettonSwap.changeJWalletAddrMessage(newAddress, jettonBalance),
      value: toNano("0.1"),
    });
  }

  static swapMessage() {
    return beginCell().storeUint(Op.swap, 32).storeUint(51117, 64).endCell();
  }

  async sendSwapMessage(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value: value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: JettonSwap.swapMessage() });
  }

  static withdrawTonsMessage(amount: bigint) {
    return beginCell().storeUint(Op.withdraw_ton, 32).storeUint(0, 64).storeCoins(amount).endCell();
  }

  async sendWithdrawTons(provider: ContractProvider, via: Sender, amount: bigint) {
    await provider.internal(via, {
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: JettonSwap.withdrawTonsMessage(amount),
      value: toNano("0.002"),
    });
  }

  // GETTERS
  async getJettonSwapData(provider: ContractProvider) {
    let { stack } = await provider.get("get_jswap_data", []);
    return {
      owner: stack.readAddress(),
      wallet_address: stack.readAddress(),
      minter: stack.readAddress(),
      jetton_balance: stack.readBigNumber()
    };
  }

  async getAdminAddress(provider: ContractProvider) {
    let res = await this.getJettonSwapData(provider);
    return res.owner;
  }

  async getJettonBalance(provider: ContractProvider) {
    let res = await this.getJettonSwapData(provider);
    return res.jetton_balance;
  }
}
