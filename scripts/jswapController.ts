import { checkJettonMinter } from '../wrappers/JettonMinterChecker';
import { Address, beginCell, Cell, fromNano, OpenedContract, toNano } from '@ton/core';
import { compile, NetworkProvider, UIProvider} from '@ton/blueprint';
import { JettonMinter, jettonMinterConfigCellToConfig, JettonMinterConfigFull, jettonMinterConfigFullToCell } from '../wrappers/JettonMinter';
import { JettonWallet } from '../wrappers/JettonWallet';
import { JettonSwap, jettonSwapConfigToCell } from '../wrappers/JettonSwap';
import { promptBool, promptAmount, promptAddress, displayContentCell, getLastBlock, waitForTransaction, getAccountLastTx, promptToncoin, promptUrl, jettonWalletCodeFromLibrary } from '../wrappers/ui-utils';
import {TonClient4} from "@ton/ton";
import { fromUnits } from '../wrappers/units';
let jettonMinterContract:OpenedContract<JettonMinter>;
let jettonSwapContract:OpenedContract<JettonSwap>;
let jettonWalletContract: OpenedContract<JettonWallet>;

const adminActions  = ['Change jetton wallet', 'Withdraw tons', 'Withdraw jettons', 'Upgrade', 'Close contract'];
const userActions   = ['Info', 'Top up', 'Quit'];
let minterCode: Cell;
let walletCode: Cell;
let adminAddress: Address | null;
let decimals: number;


const failedTransMessage = (ui:UIProvider) => {
    ui.write("Failed to get indication of transaction completion from API!\nCheck result manually, or try again\n");
};

const infoAction = async (provider:NetworkProvider, ui:UIProvider) => {
    const JSwapData = await jettonSwapContract.getJettonSwapData();
    ui.write("JettonSwap info:\n\n");
    ui.write(`Admin:${JSwapData.owner}\n`);
    ui.write(`Jetton balance:${fromNano(JSwapData.jetton_balance)}\n`);
    ui.write(`Jetton wallet address:${JSwapData.wallet_address}\n`);
    ui.write(`Jetton minter address:${JSwapData.minter}\n`)
    
};
// const topUpAction = async (provider: NetworkProvider, ui: UIProvider) => {
// }

const changeJWalletAction = async(provider:NetworkProvider, ui:UIProvider) => {
    let retry:boolean;
    let newJWalletAddress:Address;
    let jettonBalance: bigint;
    let currJWalletAddr = (await jettonSwapContract.getJettonSwapData()).wallet_address;
    do {
        retry = false;
        newJWalletAddress = await promptAddress('Please specify new jetton wallet address:', ui);
        if(newJWalletAddress.equals(currJWalletAddr)) {
            retry = true;
            ui.write("Address specified matched current jetton wallet address!\nPlease pick another one.\n");
        }
        
        jettonWalletContract = provider.open(JettonWallet.createFromAddress(newJWalletAddress));
        jettonBalance = (await jettonWalletContract.getJettonBalance());
        if (jettonBalance == 0n){
            throw new Error('Provided wallet address doesn\'t contain jettons, credit the jetton wallet first!');
            
        } else {
            ui.write(`New jetton wallet address is going to be:${newJWalletAddress}\nKindly double check it!\n`);
            retry = !(await promptBool('Is it ok?', ['yes', 'no'], ui));
        }
    } while(retry);

    const lastTx   = await getAccountLastTx(provider, jettonSwapContract.address);

    await jettonSwapContract.sendChangeJWalletAddr(provider.sender(), newJWalletAddress, jettonBalance);
    const transDone = await waitForTransaction(provider,
                                               jettonSwapContract.address,
                                               lastTx,
                                               10);
    if(transDone) {
        ui.write(`Jetton wallet address change to address:${newJWalletAddress} requested`)
    }
    else {
        failedTransMessage(ui);
    }
};

const withdrawTonsAction = async (provider: NetworkProvider, ui: UIProvider) => {
    let curTonBalance = await jettonSwapContract.getJettonBalance();
    let retry : boolean;
    let minTonsForStorage = 10000000n;

    if(curTonBalance <= minTonsForStorage) {
        throw new Error(`Current jetton swap ton balance is ${curTonBalance}, which is lower than ${minTonsForStorage} (min storage fee). Credit contract first!`);
    }
    

    do {
        retry = false;
        const withdrawAmount = await promptAmount('Please provide withdraw amount in decimal form:', decimals, ui);
        if(withdrawAmount <= curTonBalance - minTonsForStorage) {
            await jettonSwapContract.sendWithdrawTons(provider.sender(), withdrawAmount);
        }
        else {
            ui.write(`Requested ton amount must not exceed ${curTonBalance - minTonsForStorage}`);
            retry = true;
        }
    } while (retry);
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const hasSender = sender.address !== undefined;
    minterCode = await compile('JettonMinter');
    walletCode = await compile('JettonWallet');
    let   done   = false;
    let   retry:boolean;
    let   minterAddress:Address;
    let   jswapAddress:Address;

    do {
        retry = false;
        minterAddress = await promptAddress('Please enter minter address:', ui);
        jswapAddress = await promptAddress('Please enter jetton swap address:', ui);
        try {
            const verifyRes = await checkJettonMinter({isBounceable: true, isTestOnly: false, address: minterAddress},
                                                      minterCode, walletCode, provider, ui, provider.network() == 'testnet', true); 
            jettonMinterContract = verifyRes.jettonMinterContract;
            adminAddress = verifyRes.adminAddress;
            decimals     = verifyRes.decimals;
            jettonSwapContract = provider.open(JettonSwap.createFromAddress(jswapAddress));
        }
        catch(e) {
            ui.write(`Doesn't look like minter:${e}`);
            if(!(await promptBool("Are you sure it is the one", ['Yes', 'No'], ui, true))) {
                return;
            }

            jettonMinterContract = provider.open(
                JettonMinter.createFromAddress(minterAddress)
            );
            adminAddress = await jettonMinterContract.getAdminAddress();
            ui.write("Ok, boss!");
            decimals = Number(
                await promptAmount("Please specify contract decimals:", 0, ui)
            );
        }
    } while(retry);

    const isAdmin  = hasSender ? (adminAddress == null ? false : adminAddress.equals(sender.address)) : true;
    let actionList:string[];
    if(isAdmin) {
        actionList = [...adminActions, ...userActions];
        ui.write("Current wallet is minter admin!\n");
    }
    else {
        actionList = userActions;
        ui.write("Current wallet is not admin!\nAvaliable actions restricted\n");
    }

    do {
        ui.clearActionPrompt();
        const action = await ui.choose("Pick action:", actionList, (c: string) => c);
        switch(action) {
            case 'Change jetton wallet':
                await changeJWalletAction(provider, ui);
                break;
            case 'Withdraw tons':
                await withdrawTonsAction(provider, ui);
                break;
            case 'Withdraw jettons':
                ui.write('Operation is not yet supported!')
                break;            
            case 'Upgrade':
                ui.write('Operation is not yet supported!');
                break;
            case 'Info':
                await infoAction(provider, ui);
                break;
            case 'Top up':
                ui.write('Operation is not yet supported!');
                break;
            case 'Close contract':
                ui.write('Operation is not yet supported!');
                break;
            case 'Quit':
                done = true;
                break;
            default:
                ui.write('Operation is not yet supported!');
        }
    } while(!done);
}
