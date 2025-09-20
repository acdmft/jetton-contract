import {toNano} from '@ton/core';
import {JettonSwap} from '../wrappers/JettonSwap';
import {compile, NetworkProvider} from '@ton/blueprint';
import {promptUrl, promptUserFriendlyAddress} from "../wrappers/ui-utils";

export async function run(provider: NetworkProvider) {
    const isTestnet = provider.network() !== 'mainnet';

    const ui = provider.ui();

    const adminAddress = await promptUserFriendlyAddress("Enter the address of the jetton owner (admin):", ui, isTestnet);
    const minterAddress = await promptUserFriendlyAddress("Enter the address of the jetton minter:", ui, isTestnet);



    const jettonSwap = provider.open(JettonSwap.createFromConfig({
            ownerAddress: adminAddress.address,
            jwalletAddress: adminAddress.address,
            jettonMasterAddress: minterAddress.address, 
            jettonBalance: 0n
        },
        await compile('JettonSwap')));

    await jettonSwap.sendDeploy(provider.sender(), toNano("0.1"));
}
