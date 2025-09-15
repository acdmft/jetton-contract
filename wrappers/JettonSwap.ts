import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, Slice, toNano } from '@ton/core';
import { Op } from './JettonConstants';
import {endParse} from "./JettonMinter";

export type JettonSwapConfig = {
    ownerAddress: Address,
    jwalletAddress: Address,
    jettonMasterAddress: Address
};

export function jettonSwapConfigToCell(config: JettonSwapConfig): Cell {
    return beginCell()
        .storeAddress(config.ownerAddress)
        .storeAddress(config.jwalletAddress)
        .storeAddress(config.jettonMasterAddress)
        .endCell();
};

export class JettonSwap implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

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

    static changeJWalletAddrMessage(newJWalletAddress: Address) {
        return beginCell().storeUint(Op.change_jwallet_addr, 32).storeUint(0, 64) // op, queryId
            .storeAddress(newJWalletAddress)
            .endCell();
    }

    async sendChangeJWalletAddr(provider: ContractProvider, via: Sender, newAddress: Address) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonSwap.changeJWalletAddrMessage(newAddress),
            value: toNano("0.1"),
        });
    }

    async getJettonSwapData(provider: ContractProvider) {
        let { stack } = await provider.get('get_jswap_data', []);
        return {
            owner: stack.readAddress(),
            wallet_address: stack.readAddress(),
            minter: stack.readAddress()
        }
    }

    async getAdminAddress(provider: ContractProvider) {
        let res = await this.getJettonSwapData(provider);
        return res.owner;
    }
}