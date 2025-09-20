import { Blockchain, SandboxContract, TreasuryContract, internal, BlockchainSnapshot, SendMessageResult, BlockchainTransaction } from "@ton/sandbox";
import { Cell, toNano, beginCell, Address, Transaction, storeAccountStorage, Dictionary, storeMessage, fromNano, DictionaryValue, SendMode } from "@ton/core";
import { JettonWallet } from "../wrappers/JettonWallet";
import { jettonContentToCell, JettonMinter, JettonMinterContent } from "../wrappers/JettonMinter";
import "@ton/test-utils";
import { findTransactionRequired } from "@ton/test-utils";
import { compile, libraryCellFromCode } from "@ton/blueprint";
import { randomAddress, getRandomTon, differentAddress, getRandomInt } from "./utils";
import { Op, Errors } from "../wrappers/JettonConstants";
import {
  calcStorageFee,
  collectCellStats,
  computeFwdFees,
  computeFwdFeesVerbose,
  FullFees,
  GasPrices,
  getGasPrices,
  getMsgPrices,
  getStoragePrices,
  computedGeneric,
  storageGeneric,
  MsgPrices,
  setGasPrice,
  setMsgPrices,
  setStoragePrices,
  StorageStats,
  StorageValue,
  computeGasFee,
} from "../gasUtils";
import { sha256 } from "@ton/crypto";
import { JettonSwap } from "../wrappers/JettonSwap";
/*
   These tests check compliance with the TEP-74 and TEP-89,
   but also checks some implementation details.
   If you want to keep only TEP-74 and TEP-89 compliance tests,
   you need to remove/modify the following tests:
     mint tests (since minting is not covered by standard)
     exit_codes
     prove pathway
*/

//jetton params

let send_gas_fee: bigint;
let send_fwd_fee: bigint;
let receive_gas_fee: bigint;
let burn_gas_fee: bigint;
let burn_notification_fee: bigint;
let min_tons_for_storage: bigint;

describe("JettonWallet", () => {
  let jwallet_code_raw = new Cell(); // true code
  let jwallet_code = new Cell(); // library cell with reference to jwallet_code_raw
  let minter_code = new Cell();
  let jswap_code = new Cell();

  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let notDeployer: SandboxContract<TreasuryContract>;
  let jettonMinter: SandboxContract<JettonMinter>;
  let userWallet: (address: Address) => Promise<SandboxContract<JettonWallet>>;
  let jettonSwap: SandboxContract<JettonSwap>;
  let walletStats: StorageStats;
  let msgPrices: MsgPrices;
  let gasPrices: GasPrices;
  let storagePrices: StorageValue;
  let storageDuration: number;
  let stateInitStats: StorageStats;
  let defaultOverhead: bigint;
  let defaultContent: JettonMinterContent;

  let printTxGasStats: (name: string, trans: Transaction) => bigint;
  let estimateBodyFee: (body: Cell, force_ref: boolean, prices?: MsgPrices) => FullFees;
  let estimateBurnFwd: (prices?: MsgPrices) => bigint;
  let forwardOverhead: (prices: MsgPrices, stats: StorageStats) => bigint;
  let estimateTransferFwd: (amount: bigint, fwd_amount: bigint, fwd_payload: Cell | null, custom_payload: Cell | null, prices?: MsgPrices) => bigint;
  let calcSendFees: (send_fee: bigint, recv_fee: bigint, fwd_fee: bigint, fwd_amount: bigint, storage_fee: bigint, state_init?: bigint) => bigint;
  let testBurnFees: (fees: bigint, to: Address, amount: bigint, exp: number, custom: Cell | null, prices?: MsgPrices) => Promise<Array<BlockchainTransaction>>;
  let testSendFees: (fees: bigint, fwd_amount: bigint, fwd: Cell | null, custom: Cell | null, exp: boolean) => Promise<void>;

  beforeAll(async () => {
    jwallet_code_raw = await compile("JettonWallet", { buildLibrary: false });
    minter_code = await compile("JettonMinter");
    jswap_code = await compile("JettonSwap");
    blockchain = await Blockchain.create();
    blockchain.now = Math.floor(Date.now() / 1000);
    deployer = await blockchain.treasury("deployer");
    notDeployer = await blockchain.treasury("notDeployer");
    walletStats = new StorageStats(1033, 3);
    msgPrices = getMsgPrices(blockchain.config, 0);
    gasPrices = getGasPrices(blockchain.config, 0);
    storagePrices = getStoragePrices(blockchain.config);
    storageDuration = 5 * 365 * 24 * 3600;
    stateInitStats = new StorageStats(931, 3);
    defaultContent = {
      uri: "https://some_stablecoin.org/meta.json",
    };

    //jwallet_code is library
    const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    _libs.set(BigInt(`0x${jwallet_code_raw.hash().toString("hex")}`), jwallet_code_raw);
    const libs = beginCell().storeDictDirect(_libs).endCell();
    blockchain.libs = libs;
    jwallet_code = libraryCellFromCode(jwallet_code_raw);

    console.log("jetton minter code hash = ", minter_code.hash().toString("hex"));
    console.log("jetton wallet library hash = ", jwallet_code.hash().toString("hex"));
    console.log("jetton wallet code hash = ", jwallet_code_raw.hash().toString("hex"));

    jettonMinter = blockchain.openContract(
      JettonMinter.createFromConfig(
        {
          admin: deployer.address,
          wallet_code: jwallet_code,
          jetton_content: jettonContentToCell(defaultContent),
        },
        minter_code,
      ),
    );
    userWallet = async (address: Address) => blockchain.openContract(JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(address)));
    jettonSwap = blockchain.openContract(
      JettonSwap.createFromConfig(
        {
          ownerAddress: deployer.address,
          jwalletAddress: randomAddress(0), // new Address(0, Buffer.alloc(32, 0)),
          jettonMasterAddress: jettonMinter.address,
          jettonBalance: 0n
        },
        jswap_code,
      ),
    );

    printTxGasStats = (name, transaction) => {
      const txComputed = computedGeneric(transaction);
      console.log(`${name} used ${txComputed.gasUsed} gas`);
      console.log(`${name} gas cost: ${txComputed.gasFees}`);
      return txComputed.gasFees;
    };

    estimateBodyFee = (body, force_ref, prices) => {
      const curPrice = prices || msgPrices;
      const mockAddr = new Address(0, Buffer.alloc(32, "A"));
      const testMsg = internal({
        from: mockAddr,
        to: mockAddr,
        value: toNano("1"),
        body,
      });
      const packed = beginCell()
        .store(storeMessage(testMsg, { forceRef: force_ref }))
        .endCell();
      const stats = collectCellStats(packed, [], true);
      return computeFwdFeesVerbose(prices || msgPrices, stats.cells, stats.bits);
    };
    estimateBurnFwd = (prices) => {
      const curPrices = prices || msgPrices;
      return computeFwdFees(curPrices, 1n, 754n);
    };
    forwardOverhead = (prices, stats) => {
      // Meh, kinda lazy way of doing that, but tests are bloated enough already
      return computeFwdFees(prices, stats.cells, stats.bits) - prices.lumpPrice;
    };
    estimateTransferFwd = (jetton_amount, fwd_amount, fwd_payload, custom_payload, prices) => {
      // Purpose is to account for the first biggest one fwd fee.
      // So, we use fwd_amount here only for body calculation

      const mockFrom = randomAddress(0);
      const mockTo = randomAddress(0);

      const body = JettonWallet.transferMessage(jetton_amount, mockTo, mockFrom, custom_payload, fwd_amount, fwd_payload);

      const curPrices = prices || msgPrices;
      const feesRes = estimateBodyFee(body, true, curPrices);
      const reverse = (feesRes.remaining * 65536n) / (65536n - curPrices.firstFrac);
      expect(reverse).toBeGreaterThanOrEqual(feesRes.total);
      return reverse;
    };

    calcSendFees = (send, recv, fwd, fwd_amount, storage, state_init) => {
      const overhead = state_init || defaultOverhead;
      const fwdTotal = fwd_amount + (fwd_amount > 0n ? fwd * 2n : fwd) + overhead;
      const execute = send + recv;
      return fwdTotal + send + recv + storage + 1n;
    };

    testBurnFees = async (fees, to, amount, exp, custom_payload, prices) => {
      const burnWallet = await userWallet(deployer.address);
      let initialJettonBalance = await burnWallet.getJettonBalance();
      let initialTotalSupply = await jettonMinter.getTotalSupply();
      let burnTxs: Array<BlockchainTransaction> = [];
      const burnBody = JettonWallet.burnMessage(amount, to, custom_payload);
      const burnSender = blockchain.sender(deployer.address);
      const sendRes = await blockchain.sendMessage(
        internal({
          from: deployer.address,
          to: burnWallet.address,
          value: fees,
          forwardFee: estimateBodyFee(burnBody, false, prices || msgPrices).remaining,
          body: burnBody,
        }),
      );
      if (exp == 0) {
        burnTxs.push(
          findTransactionRequired(sendRes.transactions, {
            on: burnWallet.address,
            from: deployer.address,
            op: Op.burn,
            success: true,
          }),
        );
        // We expect burn to succeed, but no excess
        burnTxs.push(
          findTransactionRequired(sendRes.transactions, {
            on: jettonMinter.address,
            from: burnWallet.address,
            op: Op.burn_notification,
            success: true,
          })!,
        );

        expect(await burnWallet.getJettonBalance()).toEqual(initialJettonBalance - amount);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply - amount);
      } else {
        expect(sendRes.transactions).toHaveTransaction({
          on: burnWallet.address,
          from: deployer.address,
          op: Op.burn,
          success: false,
          exitCode: exp,
        });
        expect(sendRes.transactions).not.toHaveTransaction({
          on: jettonMinter.address,
          from: burnWallet.address,
          op: Op.burn_notification,
        });
        expect(await burnWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
      }

      return burnTxs;
    };
    testSendFees = async (fees, fwd_amount, fwd_payload, custom_payload, exp) => {
      const deployerJettonWallet = await userWallet(deployer.address);
      let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
      const someUserAddr = randomAddress(0);
      const someWallet = await userWallet(someUserAddr);

      let jettonAmount = 1n;
      const sendResult = await deployerJettonWallet.sendTransfer(deployer.getSender(), fees, jettonAmount, someUserAddr, deployer.address, custom_payload, fwd_amount, fwd_payload);

      if (exp) {
        expect(sendResult.transactions).toHaveTransaction({
          on: someWallet.address,
          op: Op.internal_transfer,
          success: true,
        });
        if (fwd_amount > 0n) {
          expect(sendResult.transactions).toHaveTransaction({
            on: someUserAddr,
            from: someWallet.address,
            op: Op.transfer_notification,
            body: (x) => {
              if (fwd_payload === null) {
                return true;
              }
              return x!.beginParse().preloadRef().equals(fwd_payload);
            },
            // We do not test for success, because receiving contract would be uninitialized
          });
        }
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - jettonAmount);
        expect(await someWallet.getJettonBalance()).toEqual(jettonAmount);
      } else {
        expect(sendResult.transactions).toHaveTransaction({
          on: deployerJettonWallet.address,
          from: deployer.address,
          op: Op.transfer,
          aborted: true,
          success: false,
          exitCode: Errors.not_enough_gas,
        });
        expect(sendResult.transactions).not.toHaveTransaction({
          on: someWallet.address,
        });
      }
    };

    defaultOverhead = forwardOverhead(msgPrices, stateInitStats);
  });

  // implementation detail
  it("should deploy", async () => {
    const deployResult = await jettonMinter.sendDeploy(deployer.getSender(), toNano("10"));

    // expect(deployResult.transactions).toHaveTransaction({
    //   from: deployer.address,
    //   to: jettonMinter.address,
    //   deploy: true,
    // });
    // // Make sure it didn't bounce
    // expect(deployResult.transactions).not.toHaveTransaction({
    //   on: deployer.address,
    //   from: jettonMinter.address,
    //   inMessageBounced: true,
    // });
    // Deploy JettonSwap contract
    const result = await jettonSwap.sendDeploy(deployer.getSender(), toNano("0.1"));
    expect(result.transactions).toHaveTransaction({
      from: deployer.address,
      to: jettonSwap.address,
      deploy: true,
    });
    expect(result.transactions).not.toHaveTransaction({
      on: deployer.address,
      from: jettonSwap.address,
      inMessageBounced: true,
    });
  });

  it("should change jetton-wallet-address when requested by owner", async () => {
    await jettonSwap.sendDeploy(deployer.getSender(), toNano("0.1"));
    const adminAddr = await jettonSwap.getAdminAddress();
    expect(adminAddr).toEqualAddress(deployer.address);
    const newJWalletAddress = randomAddress(0);
    const changeResult = await jettonSwap.sendChangeJWalletAddr(deployer.getSender(), newJWalletAddress, 0n);
    expect(changeResult.transactions).toHaveTransaction({
      from: deployer.address,
      to: jettonSwap.address,
      op: Op.change_jwallet_addr,
      success: true,
    });
    const jSwapData = await jettonSwap.getJettonSwapData();
    expect(jSwapData.wallet_address).toEqualAddress(newJWalletAddress);
  });

  it("should refuse to change wallet address to no-owner", async () => {
    await jettonSwap.sendDeploy(deployer.getSender(), toNano("0.1"));
    const changeResult = await jettonSwap.sendChangeJWalletAddr(notDeployer.getSender(), randomAddress(0), 0n);
    expect(changeResult.transactions).toHaveTransaction({
      from: notDeployer.address,
      to: jettonSwap.address,
      op: Op.change_jwallet_addr,
      exitCode: Errors.not_owner,
      success: false,
    });
  });

  it("should send transfer message to the jetton wallet when op::swap", async () => {
    // deploy jetton-swap
    await jettonMinter.sendDeploy(deployer.getSender(), toNano("10"));
    await jettonSwap.sendDeploy(deployer.getSender(), toNano("10"));
    // calculate jetton-swap wallet address
    const jettonSwapWallet = await userWallet(jettonSwap.address);
    // mint tokens for jetton-swap (create jeton-swap wallet)
    let initialJettonBalance = toNano("100.23");
    const mintResult = await jettonMinter.sendMint(deployer.getSender(), jettonSwap.address, initialJettonBalance, null, null, null, toNano("0.05"), toNano("1"));
    expect(await jettonSwapWallet.getJettonBalance()).toEqual(initialJettonBalance);
    // update jetton-wallet-address in jetton-swap
    const changeResult = await jettonSwap.sendChangeJWalletAddr(deployer.getSender(), jettonSwapWallet.address, initialJettonBalance);
    const jSwapData = await jettonSwap.getJettonSwapData();
    expect(jSwapData.wallet_address).toEqualAddress(jettonSwapWallet.address);
    // get jetton-swap and jetton-swap-wallet initial balances
    const jettonSwapInitBalance = (await blockchain.getContract(jettonSwap.address)).balance;
    const jetttonSwapWalletInitBalance = (await blockchain.getContract(jettonSwapWallet.address)).balance;
    // send swap message from notDeployer to change tons for jettons
    const jSwapResult = await jettonSwap.sendSwapMessage(notDeployer.getSender(), toNano("10.133"));
    expect(jSwapResult.transactions).toHaveTransaction({
      from: notDeployer.address,
      to: jettonSwap.address,
      op: Op.swap,
      success: true,
    });
    const expectedJettonAmount = toNano("10.133") - 48000000n - 10000000n;
    console.log("expectedJettonAmount ", expectedJettonAmount);
    expect(jSwapResult.transactions).toHaveTransaction({
      from: jettonSwap.address,
      to: jettonSwapWallet.address,
      op: Op.transfer,
      body: beginCell()
        .storeUint(Op.transfer, 32)
        .storeUint(51117, 64)
        .storeCoins(expectedJettonAmount) // jetton amount
        .storeAddress(notDeployer.address)
        .storeAddress(jettonSwap.address) // response_destination
        .storeUint(0, 1) // custom payload:(Maybe ^Cell) - nothing
        .storeCoins(12n) // forward_ton amount
        .storeUint(0, 1) // forward_payload:(Either Cell ^Cell) - left Cell
        .endCell(),
      success: true,
    });
    // check that user has received the jettons
    const notDeployerJWallet = await userWallet(notDeployer.address);
    expect(jSwapResult.transactions).toHaveTransaction({
      from: jettonSwapWallet.address,
      to: notDeployerJWallet.address,
      deploy: true,
      success: true,
    });
    expect(await notDeployerJWallet.getJettonBalance()).toEqual(expectedJettonAmount);
    // check that the jetton-swap and jetton-swap-wallet didn't diminish
    const jettonSwapNewBalance = (await blockchain.getContract(jettonSwap.address)).balance;
    expect(jettonSwapNewBalance).toBeGreaterThan(jettonSwapInitBalance);
    const jettonSwapWalletNewBalance = (await blockchain.getContract(jettonSwapWallet.address)).balance;
    expect(jettonSwapWalletNewBalance).toBeGreaterThanOrEqual(jetttonSwapWalletInitBalance);
    console.log(
      `jettonSwapInitBalance: ${jettonSwapInitBalance} \n jettonSwapNewBalance: ${jettonSwapNewBalance} \n jettonSwapWalletInitBalance: ${jetttonSwapWalletInitBalance} \n jettonSwapWalletNewBalance: ${jettonSwapWalletNewBalance}`,
    );
    
  });
  it("should throw error when too much jettons requested", async () => {
    // deploy jetton-swap
    await jettonMinter.sendDeploy(deployer.getSender(), toNano("10"));
    await jettonSwap.sendDeploy(deployer.getSender(), toNano("10"));
    // calculate jetton-swap wallet address
    const jettonSwapWallet = await userWallet(jettonSwap.address);
    // set jetton-wallet and jetton balance for jetton-swap
    let jettonWalletBalance = await jettonSwapWallet.getJettonBalance();
    await jettonSwap.sendChangeJWalletAddr(deployer.getSender(), jettonSwapWallet.address, jettonWalletBalance);
    expect(await jettonSwap.getJettonBalance()).toEqual(jettonWalletBalance);
    // check it throws error when excessive amount is demanded
    const excessiveJAmount = jettonWalletBalance + toNano('10');
    const initJSwapBalance = (await blockchain.getContract(jettonSwap.address)).balance;
    const swapTooMuchJettonResult = await jettonSwap.sendSwapMessage(notDeployer.getSender(), excessiveJAmount);
    expect(swapTooMuchJettonResult.transactions).toHaveTransaction({
      from: notDeployer.address,
      to: jettonSwap.address,
      op: Op.swap,
      success: false,
      exitCode: Errors.balance_error
    });
    // check that jetton-swap balance doesn't diminish when balance_error is thrown
    const newJSwapBalance = (await blockchain.getContract(jettonSwap.address)).balance;
    expect(newJSwapBalance).toBeGreaterThanOrEqual(initJSwapBalance);
    console.log(`initJSwapBalance: ${initJSwapBalance} \n newJSwapBalance: ${newJSwapBalance}`);
    // TODO: tests for on_bounce() - when message to jetton-wallet is bounced
  });

  it("should withdraw tons when op::withdraw_tons message from owner", async () => {
    // deploy jetton-swap, mint jettons, set wallet address, swap jettons
    await jettonSwap.sendDeploy(deployer.getSender(), toNano("1"));
    await jettonMinter.sendDeploy(deployer.getSender(), toNano("10"));
    const jettonSwapWallet = await userWallet(jettonSwap.address);
    let initialJettonBalance = toNano("1000.23");
    const mintResult = await jettonMinter.sendMint(deployer.getSender(), jettonSwap.address, initialJettonBalance, null, null, null, toNano("0.05"), toNano("1"));
    await jettonSwap.sendChangeJWalletAddr(deployer.getSender(), jettonSwapWallet.address, initialJettonBalance);
    const jSwapResult = await jettonSwap.sendSwapMessage(notDeployer.getSender(), toNano("10.133"));
    // withdraw tons
    const withdrawResult = await jettonSwap.sendWithdrawTons(deployer.getSender(), toNano("5"));
    expect(withdrawResult.transactions).toHaveTransaction({
      from: jettonSwap.address,
      to: deployer.address,
      value: toNano("5"),
      success: true,
    });
    // check that it keeps the minimum storage amount
    min_tons_for_storage = 10000000n;
    const jswapBalance = (await blockchain.getContract(jettonSwap.address)).balance;
    const withdrawAmount = jswapBalance + 10000n;
    const withdrawTooMuchResult = await jettonSwap.sendWithdrawTons(deployer.getSender(), withdrawAmount);
    expect(withdrawTooMuchResult.transactions).toHaveTransaction({
      from: jettonSwap.address,
      to: deployer.address,
      // value: jswapBalance - min_tons_for_storage,
      success: true,
    });
    // check that it refuses to withdraw when message is not from owner (admin)
    await notDeployer.send({
      to: jettonSwap.address,
      value: toNano("1"),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
    });
    const nonEligibleWithdrawResult = await jettonSwap.sendWithdrawTons(notDeployer.getSender(), toNano("1"));
    expect(nonEligibleWithdrawResult.transactions).toHaveTransaction({
      to: jettonSwap.address,
      from: notDeployer.address,
      op: Op.withdraw_ton,
      success: false,
      exitCode: Errors.not_owner,
    });
  });
});
