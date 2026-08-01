const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, SystemProgram, Transaction } = require('@solana/web3.js');
const { createTransferInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const { ethers } = require('ethers');
const bitcoin = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const ecc = require('tiny-secp256k1');
const TronWeb = require('tronweb');
const bs58 = require('bs58');
const { google } = require('googleapis');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const app = express();

const ECPair = ECPairFactory(ecc);

// ============================================================
// 🔥 LOGGING
// ============================================================
const logger = winston.createLogger({
level: 'info',
format: winston.format.combine(
winston.format.timestamp(),
winston.format.printf(({ timestamp, level, message }) => {
return `${timestamp} [${level}]: ${message}`;
})
),
transports: [
new winston.transports.Console(),
new winston.transports.File({ filename: 'dubpay.log' })
]
});

app.use(cors());
app.use(express.json());

// ============================================================
// 🔥 RATE LIMITING
// ============================================================
const limiter = rateLimit({
windowMs: 15 * 60 * 1000,
max: 100,
message: 'Too many requests, please try again later.'
});
app.use('/api/', limiter);

// ============================================================
// 🔥 GOOGLE SHEETS SETUP
// ============================================================
const sheets = google.sheets('v4');

const GOOGLE_SHEETS_PRIVATE_KEY = process.env.GOOGLE_SHEETS_PRIVATE_KEY || '';
const GOOGLE_SHEETS_CLIENT_EMAIL = process.env.GOOGLE_SHEETS_CLIENT_EMAIL || '';
const GOOGLE_SHEETS_SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '';

let googleAuth = null;

function getGoogleAuth() {
if (!googleAuth && GOOGLE_SHEETS_PRIVATE_KEY && GOOGLE_SHEETS_CLIENT_EMAIL) {
googleAuth = new google.auth.JWT({
email: GOOGLE_SHEETS_CLIENT_EMAIL,
key: GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
}
return googleAuth;
}

async function appendToSheet(tx_ref, orderData) {
try {
const auth = getGoogleAuth();
if (!auth || !GOOGLE_SHEETS_SPREADSHEET_ID) {
logger.warn('Google Sheets not configured - skipping save');
return;
}

const values = [[
tx_ref,
orderData.coinSymbol || '',
orderData.cryptoAmount || 0,
orderData.walletAddress || '',
orderData.network || 'Default',
orderData.amountUSD || 0,
orderData.amountNGN || 0,
orderData.status || 'pending',
orderData.txId || '',
orderData.explorerUrl || '',
orderData.createdAt || new Date().toISOString(),
orderData.completedAt || '',
orderData.email || '',
orderData.name || '',
JSON.stringify(orderData.paymentData || {})
]];

await sheets.spreadsheets.values.append({
auth: auth,
spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
range: 'Sheet1!A:O',
valueInputOption: 'USER_ENTERED',
requestBody: { values }
});

logger.info(`✅ Order ${tx_ref} saved to Google Sheets`);
} catch (error) {
logger.error(`❌ Failed to save to Google Sheets: ${error.message}`);
}
}

async function updateSheetRow(tx_ref, updates) {
try {
const auth = getGoogleAuth();
if (!auth || !GOOGLE_SHEETS_SPREADSHEET_ID) {
logger.warn('Google Sheets not configured - skipping update');
return;
}

const response = await sheets.spreadsheets.values.get({
auth: auth,
spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
range: 'Sheet1!A:A'
});

const rows = response.data.values;
let rowIndex = -1;
for (let i = 0; i < rows.length; i++) {
if (rows[i][0] === tx_ref) {
rowIndex = i + 1;
break;
}
}

if (rowIndex === -1) {
logger.warn(`⚠️ Order ${tx_ref} not found in Google Sheets`);
return;
}

const updateData = [];
const columns = {
status: 7,
txId: 8,
explorerUrl: 9,
completedAt: 11,
paymentData: 14
};

for (const [key, value] of Object.entries(updates)) {
if (columns[key]) {
updateData.push({
range: `Sheet1!${String.fromCharCode(64 + columns[key])}${rowIndex}`,
values: [[value]]
});
}
}

for (const update of updateData) {
await sheets.spreadsheets.values.update({
auth: auth,
spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
range: update.range,
valueInputOption: 'USER_ENTERED',
requestBody: { values: update.values }
});
}

logger.info(`✅ Order ${tx_ref} updated in Google Sheets`);
} catch (error) {
logger.error(`❌ Failed to update Google Sheets: ${error.message}`);
}
}

async function getOrdersFromSheet() {
try {
const auth = getGoogleAuth();
if (!auth || !GOOGLE_SHEETS_SPREADSHEET_ID) {
logger.warn('Google Sheets not configured');
return {};
}

const response = await sheets.spreadsheets.values.get({
auth: auth,
spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
range: 'Sheet1!A:O'
});

const rows = response.data.values;
if (!rows || rows.length <= 1) return {};

const orders = {};
for (let i = 1; i < rows.length; i++) {
const row = rows[i];
if (row[0]) {
orders[row[0]] = {
tx_ref: row[0],
coinSymbol: row[1] || '',
cryptoAmount: parseFloat(row[2]) || 0,
walletAddress: row[3] || '',
network: row[4] || 'Default',
amountUSD: parseFloat(row[5]) || 0,
amountNGN: parseFloat(row[6]) || 0,
status: row[7] || 'pending',
txId: row[8] || '',
explorerUrl: row[9] || '',
createdAt: row[10] || new Date().toISOString(),
completedAt: row[11] || '',
email: row[12] || '',
name: row[13] || '',
paymentData: row[14] ? JSON.parse(row[14]) : {}
};
}
}

return orders;
} catch (error) {
logger.error(`❌ Failed to read Google Sheets: ${error.message}`);
return {};
}
}

// ============================================================
// 🔥 CONFIGURATION
// ============================================================
const FLUTTERWAVE_SECRET = process.env.FLUTTERWAVE_SECRET;
const FLUTTERWAVE_WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://dubem-backend-dubpay.onrender.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dubpaydub.netlify.app';

const INFURA_KEY = process.env.INFURA_KEY;

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const AVALANCHE_RPC = 'https://api.avax.network/ext/bc/C/rpc';
const TRON_RPC = 'https://api.trongrid.io';
const ETH_RPC = `https://mainnet.infura.io/v3/${INFURA_KEY}`;
const POLYGON_RPC = 'https://polygon-rpc.com';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const OPTIMISM_RPC = 'https://mainnet.optimism.io';
const FANTOM_RPC = 'https://rpc.ftm.tools';

// ============================================================
// 🔥 WALLET CONFIGURATION
// ============================================================
logger.info('🔍 Checking environment variables...');

const WALLETS = {
BTC: {
address: process.env.BTC_ADDRESS || '',
privateKey: process.env.BTC_PRIVATE_KEY || '',
network: 'bitcoin'
},
ETH: {
address: process.env.ETH_ADDRESS || '',
privateKey: process.env.ETH_PRIVATE_KEY || '',
network: 'ethereum'
},
BNB: {
address: process.env.BNB_ADDRESS || '',
privateKey: process.env.BNB_PRIVATE_KEY || '',
network: 'bsc'
},
SOL: {
address: process.env.SOL_ADDRESS || '',
privateKey: process.env.SOL_PRIVATE_KEY || '',
network: 'solana'
},
TRX: {
address: process.env.TRX_ADDRESS || '',
privateKey: process.env.TRX_PRIVATE_KEY || '',
network: 'tron'
},
AVAX: {
address: process.env.AVAX_ADDRESS || '',
privateKey: process.env.AVAX_PRIVATE_KEY || '',
network: 'avalanche'
},
MATIC: {
address: process.env.MATIC_ADDRESS || process.env.ETH_ADDRESS || '',
privateKey: process.env.MATIC_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '',
network: 'polygon'
},
ARB: {
address: process.env.ARB_ADDRESS || process.env.ETH_ADDRESS || '',
privateKey: process.env.ARB_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '',
network: 'arbitrum'
},
OP: {
address: process.env.OP_ADDRESS || process.env.ETH_ADDRESS || '',
privateKey: process.env.OP_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '',
network: 'optimism'
},
FTM: {
address: process.env.FTM_ADDRESS || process.env.ETH_ADDRESS || '',
privateKey: process.env.FTM_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '',
network: 'fantom'
}
};

Object.keys(WALLETS).forEach(coin => {
const wallet = WALLETS[coin];
if (wallet.privateKey) {
logger.info(`✅ ${coin} wallet configured`);
} else {
logger.warn(`⚠️ ${coin} wallet NOT configured (missing private key)`);
}
});

// ============================================================
// 🔥 COIN TO WALLET MAPPING
// ============================================================
const COIN_TO_WALLET = {
'BTC': 'BTC',
'ETH': 'ETH',
'USDC': {
'ERC20': 'ETH',
'SOL': 'SOL',
'BNB': 'BNB'
},
'USDT': {
'ERC20': 'ETH',
'SOL': 'SOL',
'BNB': 'BNB',
'TRC20': 'TRX'
},
'BNB': 'BNB',
'SOL': 'SOL',
'AVAX': 'AVAX',
'MATIC': 'MATIC',
'ARB': 'ARB',
'OP': 'OP',
'FTM': 'FTM'
};

function getWalletForCoin(coinSymbol, network) {
let walletKey;

if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
if (!network) {
network = 'ERC20';
}
walletKey = COIN_TO_WALLET[coinSymbol][network];
if (!walletKey) {
throw new Error(`No wallet for ${coinSymbol} on network ${network}. Available: ${Object.keys(COIN_TO_WALLET[coinSymbol]).join(', ')}`);
}
} else {
walletKey = COIN_TO_WALLET[coinSymbol];
if (!walletKey) {
throw new Error(`No wallet mapping for ${coinSymbol}`);
}
}

const wallet = WALLETS[walletKey];
if (!wallet || !wallet.privateKey) {
throw new Error(`Private key not configured for ${coinSymbol} (wallet: ${walletKey})`);
}

return wallet;
}

// ============================================================
// 🔥 PRIVATE KEY PARSER
// ============================================================
function parsePrivateKey(privateKeyInput, coinName) {
logger.info(`🔑 Parsing private key for ${coinName}...`);

if (!privateKeyInput) {
throw new Error(`No private key provided for ${coinName}`);
}

const input = privateKeyInput.trim();

if (input.length >= 80 && input.length <= 100) {
try {
const decoded = bs58.decode(input);
if (decoded.length === 64 || decoded.length === 32) {
logger.info(`✅ ${coinName}: Using Base58 format (${decoded.length} bytes)`);
return Uint8Array.from(decoded);
}
} catch (e) { /* Not Base58 */ }
}

try {
const array = JSON.parse(input);
if (Array.isArray(array) && (array.length === 64 || array.length === 32)) {
logger.info(`✅ ${coinName}: Using JSON array format (${array.length} bytes)`);
return Uint8Array.from(array);
}
} catch (e) { /* Not JSON array */ }

try {
const base64Buffer = Buffer.from(input, 'base64');
if (base64Buffer.length === 64 || base64Buffer.length === 32) {
logger.info(`✅ ${coinName}: Using Base64 format (${base64Buffer.length} bytes)`);
return Uint8Array.from(base64Buffer);
}
} catch (e) { /* Not Base64 */ }

try {
const hexClean = input.replace('0x', '').trim();
if (/^[0-9a-f]{64}$/i.test(hexClean) || /^[0-9a-f]{128}$/i.test(hexClean) || /^[0-9a-f]{32}$/i.test(hexClean)) {
logger.info(`✅ ${coinName}: Using Hex format`);
const buffer = Buffer.from(hexClean, 'hex');
return Uint8Array.from(buffer);
}
} catch (e) { /* Not Hex */ }

if (input.startsWith('5') || input.startsWith('K') || input.startsWith('L') || input.startsWith('T')) {
logger.info(`✅ ${coinName}: Using WIF format`);
return input;
}

logger.info(`✅ ${coinName}: Using raw string format`);
return input;
}

// ============================================================
// 🔥 BALANCE CHECKS
// ============================================================
async function getWalletBalance(coinSymbol, network) {
logger.info(`🔍 Checking balance for ${coinSymbol}...`);

try {
const wallet = getWalletForCoin(coinSymbol, network);
const address = wallet.address;

if (!address) {
logger.warn(`⚠️ No address configured for ${coinSymbol}`);
return 0;
}

// ============================================================
// 🔥 BTC BALANCE CHECK - FIXED WITH MULTIPLE FALLBACKS
// ============================================================
if (coinSymbol === 'BTC') {
const errors = [];

// PRIMARY: blockchair.com
try {
logger.info(`📡 Checking BTC via blockchair.com for: ${address}`);
const response = await axios.get(`https://api.blockchair.com/bitcoin/testnet/dashboards/address/${address}`, {
timeout: 10000
});
const balance = response.data.data[address].address.balance / 100000000;
logger.info(`💰 BTC Balance (blockchair.com): ${balance} BTC`);
return balance;
} catch (error) {
errors.push(`blockchair.com: ${error.message}`);
logger.warn(`⚠️ Blockchair.com failed: ${error.message}`);
}

// FALLBACK 1: blockchain.info
try {
logger.info(`📡 Checking BTC via blockchain.info for: ${address}`);
const response = await axios.get(`https://blockstream.info/testnet/api/address/{address}`, {
headers: { 'Cache-Control': 'no-cache' },
timeout: 8000
});
const balance = response.data / 100000000;
logger.info(`💰 BTC Balance (blockstream.info): ${balance} BTC`);
return balance;
} catch (error) {
errors.push(`blockstream.info: ${error.message}`);
logger.warn(`⚠️ Blockchain.info failed: ${error.message}`);
}

// FALLBACK 2: mempool.space
try {
logger.info(`📡 Checking BTC via mempool.space for: ${address}`);
const response = await axios.get(`https://mempool.space/testnet/api/address/${address}`, {
headers: { 'Cache-Control': 'no-cache' },
timeout: 8000
});
const balance = response.data.chain_stats.funded_txo_sum / 100000000;
logger.info(`💰 BTC Balance (mempool.space): ${balance} BTC`);
return balance;
} catch (error) {
errors.push(`mempool.space: ${error.message}`);
logger.warn(`⚠️ Mempool.space failed: ${error.message}`);
}

logger.error(`❌ All BTC balance checks failed: ${errors.join(' | ')}`);
return 0;
}

if (coinSymbol === 'ETH') {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'SOL') {
const connection = new Connection(SOLANA_RPC);
const publicKey = new PublicKey(address);
const balance = await connection.getBalance(publicKey);
return balance / LAMPORTS_PER_SOL;
}

if (coinSymbol === 'USDC' && network === 'SOL') {
const connection = new Connection(SOLANA_RPC);
const publicKey = new PublicKey(address);
const tokenAddress = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, { mint: tokenAddress });
if (tokenAccounts.value.length > 0) {
const accountInfo = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
return accountInfo.value.uiAmount || 0;
}
return 0;
}

if ((coinSymbol === 'USDC' && network === 'ERC20') || (coinSymbol === 'USDT' && network === 'ERC20')) {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
const contractAddress = coinSymbol === 'USDC'
? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
: '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const abi = ['function balanceOf(address) view returns (uint256)'];
const contract = new ethers.Contract(contractAddress, abi, provider);
const balance = await contract.balanceOf(address);
return parseFloat(ethers.formatUnits(balance, 6));
}

if (coinSymbol === 'BNB') {
const provider = new ethers.JsonRpcProvider(BSC_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'AVAX') {
const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'MATIC') {
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'ARB') {
const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'OP') {
const provider = new ethers.JsonRpcProvider(OPTIMISM_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'FTM') {
const provider = new ethers.JsonRpcProvider(FANTOM_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'TRX') {
try {
const tronWeb = new TronWeb({
fullHost: TRON_RPC,
privateKey: wallet.privateKey
});
const balance = await tronWeb.trx.getBalance(address);
return balance / 1000000;
} catch {
return 0;
}
}

if (coinSymbol === 'USDT' && network === 'TRC20') {
try {
const tronWeb = new TronWeb({
fullHost: TRON_RPC,
privateKey: wallet.privateKey
});
const contractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const contract = await tronWeb.contract().at(contractAddress);
const balance = await contract.balanceOf(address).call();
return balance / 1000000;
} catch {
return 0;
}
}

return 0;
} catch (error) {
logger.error(`❌ Balance check error for ${coinSymbol}:`, error.message);
return 0;
}
}

// ============================================================
// 🔥 SEND FUNCTIONS
// ============================================================

function parseEVMPrivateKey(privateKeyInput) {
let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = '0x' + Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = '0x' + privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (!privateKeyInput.startsWith('0x') && /^[0-9a-f]{64}$/i.test(privateKeyInput)) {
privateKey = '0x' + privateKeyInput;
}
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = '0x' + Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}
return privateKey;
}

// 📌 SEND MATIC
async function sendMATIC(privateKeyInput, toAddress, amountMATIC) {
try {
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountMATIC.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) {
logger.error('❌ MATIC send error:', error.message);
throw error;
}
}

// 📌 SEND ARB
async function sendARB(privateKeyInput, toAddress, amountARB) {
try {
const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountARB.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) {
logger.error('❌ ARB send error:', error.message);
throw error;
}
}

// 📌 SEND OP
async function sendOP(privateKeyInput, toAddress, amountOP) {
try {
const provider = new ethers.JsonRpcProvider(OPTIMISM_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountOP.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) {
logger.error('❌ OP send error:', error.message);
throw error;
}
}

// 📌 SEND FTM
async function sendFTM(privateKeyInput, toAddress, amountFTM) {
try {
const provider = new ethers.JsonRpcProvider(FANTOM_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountFTM.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) {
logger.error('❌ FTM send error:', error.message);
throw error;
}
}

// 📌 SEND TRX
async function sendTRX(privateKeyInput, toAddress, amountTRX) {
try {
let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}

const tronWeb = new TronWeb({
fullHost: TRON_RPC,
privateKey: privateKey
});

const amount = amountTRX * 1000000;
const result = await tronWeb.trx.sendTransaction(toAddress, amount);
if (result.result) {
return result.transaction.txID;
} else {
throw new Error('TRX send failed');
}
} catch (error) {
logger.error('❌ TRX send error:', error.message);
throw error;
}
}

// ============================================================
// 🔥 SEND BTC - FIXED! NOW USES ALL UTXOs
// ============================================================
async function sendBTC(privateKeyInput, toAddress, amountBTC) {
try {
const wallet = getWalletForCoin('BTC');
logger.info(`📤 Sending ${amountBTC} BTC from ${wallet.address} to ${toAddress}`);

// Get UTXOs
let utxos;
try {
const response = await axios.get(`https://mempool.space/api/address/${wallet.address}/utxo`);
utxos = (response.data || []).filter(
    utxo => utxo.status.confirmed
);
} catch (error) {
logger.warn('⚠️ Mempool.space failed, trying blockchain.info...');
const response = await axios.get(`https://blockchain.info/unspent?active=${wallet.address}`);
utxos = response.data.unspent_outputs.map(utxo => ({
txid: utxo.tx_hash,
vout: utxo.tx_output_n,
value: utxo.value,
scriptpubkey: utxo.script
}));
}

if (!utxos || utxos.length === 0) {
throw new Error('No UTXOs found for this address. Please fund your BTC wallet.');
}

const satoshisNeeded = Math.round(amountBTC * 100000000);

// ✅ FIXED: Use ALL UTXOs
const totalAvailable = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
logger.info(`💰 Total available: ${totalAvailable} sats (${(totalAvailable/100000000).toFixed(8)} BTC)`);

// Calculate fee based on number of UTXOs
const feeRate = 10; // sats/vbyte

const txSize =
selectedUTXOs.length * 148 +
34 * 2 +
10;

const estimatedFee =
feeRate * txSize;
const totalNeeded = satoshisNeeded + estimatedFee;

if (totalAvailable < totalNeeded) {
const shortage = totalNeeded - totalAvailable;
throw new Error(
`Insufficient funds! Have ${totalAvailable} sats (${(totalAvailable/100000000).toFixed(8)} BTC), ` +
`Need ${totalNeeded} sats (${(totalNeeded/100000000).toFixed(8)} BTC) including fee. ` +
`Shortage: ${shortage} sats (${(shortage/100000000).toFixed(8)} BTC).`
);
}

// ✅ FIXED: Select ALL UTXOs, not just some
let selectedUTXOs = utxos;
let totalSats = totalAvailable;

logger.info(`✅ Using ALL ${selectedUTXOs.length} UTXOs, total: ${totalSats} sats`);

let privateKeyWIF = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKeyWIF = Buffer.from(privateKeyInput).toString('hex');
}
if (Buffer.isBuffer(privateKeyInput)) {
privateKeyWIF = privateKeyInput.toString('hex');
}

let keyPair;

if (
  typeof privateKeyWIF === "string" &&
  (privateKeyWIF.startsWith("K") ||
   privateKeyWIF.startsWith("L") ||
   privateKeyWIF.startsWith("5") ||
   privateKeyWIF.startsWith("c"))
) {
  keyPair = ECPair.fromWIF(
    privateKeyWIF,
    bitcoin.networks.bitcoin
  );
} else {
  keyPair = ECPair.fromPrivateKey(
    Buffer.from(privateKeyWIF, "hex")
  );
}

const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });

for (const utxo of selectedUTXOs) {
let rawTx;
try {
const response = await axios.get(`https://mempool.space/testnet/api/tx/${utxo.txid}/hex`);
rawTx = response.data;
} catch (error) {
logger.warn('⚠️ Mempool.space tx fetch failed, trying blockchain.info...');
const response = await axios.get(`https://blockchain.info/rawtx/${utxo.txid}`);
rawTx = response.data;
}

psbt.addInput({
  hash: utxo.txid,
  index: utxo.vout,
  witnessUtxo: {
    script: Buffer.from(utxo.scriptpubkey, 'hex'),
    value: utxo.value
  }
});
}

psbt.addOutput({
address: toAddress,
value: satoshisNeeded
});

// Calculate fee and change
const fee = Math.min(estimatedFee, totalSats - satoshisNeeded - 1000);
const change = totalSats - satoshisNeeded - fee;

if (change > 546) {
psbt.addOutput({
address: wallet.address,
value: change
});
logger.info(`💰 Change: ${change} sats sent back to wallet`);
} else {
logger.info(`💰 No significant change (${change} sats)`);
}

logger.info(`💰 Actual fee: ${fee} sats`);

for (let i = 0; i < selectedUTXOs.length; i++) {
psbt.signInput(i, keyPair);
}

psbt.finalizeAllInputs();
const tx = psbt.extractTransaction();
const txHex = tx.toHex();

let broadcastResponse;
try {
broadcastResponse = await axios.post('https://mempool.space/testnet/api/tx', txHex);
} catch (error) {
logger.warn('⚠️ Mempool.space broadcast failed, trying blockchain.info...');
broadcastResponse = await axios.post('https://blockchain.info/pushtx', `tx=${txHex}`);
}

logger.info(`✅ BTC Transaction broadcasted: ${broadcastResponse.data}`);
return broadcastResponse.data;
} catch (error) {
logger.error('❌ BTC send error:', error.message);
throw error;
}
}

// 📌 SEND ETH
async function sendETH(privateKeyInput, toAddress, amountETH) {
try {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountETH.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) {
logger.error('❌ ETH send error:', error.message);
throw error;
}
}

// 📌 SEND SOL
async function sendSOL(privateKeyInput, toAddress, amountSOL) {
try {
logger.info(`📤 Sending ${amountSOL} SOL to ${toAddress}`);
const connection = new Connection(SOLANA_RPC);
let secretKey = parsePrivateKey(privateKeyInput, 'SOL');

if (typeof secretKey === 'string') {
try {
const decoded = bs58.decode(secretKey);
if (decoded.length === 64) {
secretKey = Uint8Array.from(decoded);
logger.info('✅ SOL: Using Base58 format');
}
} catch (e) { /* Not base58 */ }
if (typeof secretKey === 'string') {
try {
const buffer = Buffer.from(secretKey, 'base64');
if (buffer.length === 64) {
secretKey = Uint8Array.from(buffer);
logger.info('✅ SOL: Using Base64 format');
}
} catch (e) { /* Not base64 */ }
}
if (typeof secretKey === 'string') {
try {
const hexClean = secretKey.replace('0x', '').trim();
if (/^[0-9a-f]{64}$/i.test(hexClean)) {
secretKey = Uint8Array.from(Buffer.from(hexClean, 'hex'));
logger.info('✅ SOL: Using Hex format');
}
} catch (e) { /* Not hex */ }
}
}
if (typeof secretKey === 'string') {
try {
const array = JSON.parse(secretKey);
if (Array.isArray(array) && array.length === 64) {
secretKey = Uint8Array.from(array);
logger.info('✅ SOL: Using JSON array format');
}
} catch (e) { /* Not JSON */ }
}
if (!secretKey || secretKey.length !== 64) {
throw new Error(`Invalid Solana private key. Length: ${secretKey ? secretKey.length : 'undefined'}, expected 64 bytes`);
}

const fromKeypair = Keypair.fromSecretKey(secretKey);
const toPublicKey = new PublicKey(toAddress);
const lamports = Math.round(amountSOL * LAMPORTS_PER_SOL);

const transaction = new Transaction().add(
SystemProgram.transfer({
fromPubkey: fromKeypair.publicKey,
toPubkey: toPublicKey,
lamports: lamports
})
);
const signature = await connection.sendTransaction(transaction, [fromKeypair]);
await connection.confirmTransaction(signature);
return signature;
} catch (error) {
logger.error('❌ SOL send error:', error.message);
throw error;
}
}

// 📌 SEND BNB
async function sendBNB(privateKeyInput, toAddress, amountBNB) {
try {
const provider = new ethers.JsonRpcProvider(BSC_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountBNB.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) {
logger.error('❌ BNB send error:', error.message);
throw error;
}
}

// 📌 SEND AVAX
async function sendAVAX(privateKeyInput, toAddress, amountAVAX) {
try {
const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();
const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountAVAX.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) {
logger.error('❌ AVAX send error:', error.message);
throw error;
}
}

// 📌 SEND USDC ON SOLANA
async function sendUSDCOnSolana(privateKeyInput, toAddress, amountUSDC) {
try {
const connection = new Connection(SOLANA_RPC);
let secretKey = parsePrivateKey(privateKeyInput, 'USDC-SOL');

if (typeof secretKey === 'string') {
try {
const decoded = bs58.decode(secretKey);
if (decoded.length === 64) {
secretKey = Uint8Array.from(decoded);
logger.info('✅ USDC-SOL: Using Base58 format');
}
} catch (e) { /* Not base58 */ }
if (typeof secretKey === 'string') {
try {
const buffer = Buffer.from(secretKey, 'base64');
if (buffer.length === 64) {
secretKey = Uint8Array.from(buffer);
logger.info('✅ USDC-SOL: Using Base64 format');
}
} catch (e) { /* Not base64 */ }
}
if (typeof secretKey === 'string') {
try {
const hexClean = secretKey.replace('0x', '').trim();
if (/^[0-9a-f]{64}$/i.test(hexClean)) {
secretKey = Uint8Array.from(Buffer.from(hexClean, 'hex'));
logger.info('✅ USDC-SOL: Using Hex format');
}
} catch (e) { /* Not hex */ }
}
}
if (typeof secretKey === 'string') {
try {
const array = JSON.parse(secretKey);
if (Array.isArray(array) && array.length === 64) {
secretKey = Uint8Array.from(array);
logger.info('✅ USDC-SOL: Using JSON array format');
}
} catch (e) { /* Not JSON */ }
}
if (!secretKey || secretKey.length !== 64) {
throw new Error(`Invalid Solana private key. Length: ${secretKey ? secretKey.length : 'undefined'}, expected 64 bytes`);
}

const fromKeypair = Keypair.fromSecretKey(secretKey);
const TOKEN_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const toPublicKey = new PublicKey(toAddress);
const fromTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, fromKeypair.publicKey);
const toTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, toPublicKey);

const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
const transaction = new Transaction();
if (!toAccountInfo) {
transaction.add(
createAssociatedTokenAccountInstruction(
fromKeypair.publicKey,
toTokenAccount,
toPublicKey,
TOKEN_MINT
)
);
}
const amount = Math.round(amountUSDC * 1000000);
const transferIx = createTransferInstruction(
fromTokenAccount,
toTokenAccount,
fromKeypair.publicKey,
amount
);
transaction.add(transferIx);
const signature = await connection.sendTransaction(transaction, [fromKeypair]);
await connection.confirmTransaction(signature);
return signature;
} catch (error) {
logger.error('❌ USDC Solana send error:', error.message);
throw error;
}
}

// 📌 SEND ERC20 TOKEN
async function sendERC20(privateKeyInput, toAddress, amount, contractAddress, decimals = 6) {
try {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
let privateKey = parseEVMPrivateKey(privateKeyInput);
const wallet = new ethers.Wallet(privateKey, provider);
const abi = ['function transfer(address to, uint256 amount) returns (bool)'];
const contract = new ethers.Contract(contractAddress, abi, wallet);
const amountUnits = ethers.parseUnits(amount.toString(), decimals);
const feeData = await provider.getFeeData();
const tx = await contract.transfer(toAddress, amountUnits, {
gasLimit: 100000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) {
logger.error('❌ ERC20 send error:', error.message);
throw error;
}
}

// 📌 SEND USDT ON TRON
async function sendUSDTOnTron(privateKeyInput, toAddress, amountUSDT) {
try {
let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}
const tronWeb = new TronWeb({
fullHost: TRON_RPC,
privateKey: privateKey
});
const contractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const contract = await tronWeb.contract().at(contractAddress);
const amount = amountUSDT * 1000000;
const result = await contract.transfer(toAddress, amount).send();
return result.transaction_id;
} catch (error) {
logger.error('❌ USDT TRC20 send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 MAIN SEND FUNCTION WITH RETRY LOGIC
// ============================================================
async function sendCryptoFromWallet(coinSymbol, toAddress, amount, network) {
const maxRetries = 3;
let lastError = null;

for (let attempt = 1; attempt <= maxRetries; attempt++) {
try {
logger.info(`📤 Attempt ${attempt}: Sending ${amount} ${coinSymbol} to ${toAddress}`);
logger.info(`🌐 Network: ${network || 'Default'}`);

const wallet = getWalletForCoin(coinSymbol, network);

if (!wallet.privateKey) {
throw new Error(`Private key not configured for ${coinSymbol}`);
}

const estimatedFeeBTC = 0.00001;

if(balance < amount + estimatedFeeBTC){
    throw new Error(
        "Not enough BTC for amount + fee."
    );
}

let txId;
let explorerUrl;

if (coinSymbol === 'BTC') {
txId = await sendBTC(wallet.privateKey, toAddress, amount);
explorerUrl = `https://mempool.space/testnet/tx/${txId}`;
}
else if (coinSymbol === 'ETH') {
txId = await sendETH(wallet.privateKey, toAddress, amount);
explorerUrl = `https://etherscan.io/tx/${txId}`;
}
else if (coinSymbol === 'SOL') {
txId = await sendSOL(wallet.privateKey, toAddress, amount);
explorerUrl = `https://solscan.io/tx/${txId}`;
}
else if (coinSymbol === 'BNB') {
txId = await sendBNB(wallet.privateKey, toAddress, amount);
explorerUrl = `https://bscscan.com/tx/${txId}`;
}
else if (coinSymbol === 'AVAX') {
txId = await sendAVAX(wallet.privateKey, toAddress, amount);
explorerUrl = `https://snowtrace.io/tx/${txId}`;
}
else if (coinSymbol === 'MATIC') {
txId = await sendMATIC(wallet.privateKey, toAddress, amount);
explorerUrl = `https://polygonscan.com/tx/${txId}`;
}
else if (coinSymbol === 'ARB') {
txId = await sendARB(wallet.privateKey, toAddress, amount);
explorerUrl = `https://arbiscan.io/tx/${txId}`;
}
else if (coinSymbol === 'OP') {
txId = await sendOP(wallet.privateKey, toAddress, amount);
explorerUrl = `https://optimistic.etherscan.io/tx/${txId}`;
}
else if (coinSymbol === 'FTM') {
txId = await sendFTM(wallet.privateKey, toAddress, amount);
explorerUrl = `https://ftmscan.com/tx/${txId}`;
}
else if (coinSymbol === 'TRX') {
txId = await sendTRX(wallet.privateKey, toAddress, amount);
explorerUrl = `https://tronscan.org/#/transaction/${txId}`;
}
else if (coinSymbol === 'USDC' && network === 'SOL') {
txId = await sendUSDCOnSolana(wallet.privateKey, toAddress, amount);
explorerUrl = `https://solscan.io/tx/${txId}`;
}
else if (coinSymbol === 'USDT' && network === 'TRC20') {
txId = await sendUSDTOnTron(wallet.privateKey, toAddress, amount);
explorerUrl = `https://tronscan.org/#/transaction/${txId}`;
}
else if ((coinSymbol === 'USDC' && network === 'ERC20') || (coinSymbol === 'USDT' && network === 'ERC20')) {
const contractAddress = coinSymbol === 'USDC'
? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
: '0xdAC17F958D2ee523a2206206994597C13D831ec7';
txId = await sendERC20(wallet.privateKey, toAddress, amount, contractAddress, 6);
explorerUrl = `https://etherscan.io/tx/${txId}`;
}
else {
throw new Error(`Sending not implemented for ${coinSymbol}`);
}

logger.info(`✅ Transaction sent! TxID: ${txId}`);
logger.info(`🔗 Explorer: ${explorerUrl}`);

return {
success: true,
txId: txId,
explorerUrl: explorerUrl,
amountSent: amount,
fromAddress: wallet.address,
toAddress: toAddress,
attempt: attempt
};

} catch (error) {
lastError = error;
logger.error(`❌ Attempt ${attempt} failed: ${error.message}`);

if (attempt < maxRetries) {
const delay = attempt * 2000;
logger.info(`⏳ Retrying in ${delay/1000} seconds...`);
await new Promise(resolve => setTimeout(resolve, delay));
}
}
}

logger.error(`❌ All ${maxRetries} attempts failed for ${coinSymbol}`);
return {
success: false,
error: lastError ? lastError.message : 'Unknown error'
};
}

// ============================================================
// 📌 PROCESS SUCCESSFUL ORDER
// ============================================================
async function processSuccessfulOrder(order, paymentData) {
try {
logger.info(`\n🚀 Processing order: ${order.tx_ref}`);

if (order.status === 'completed') {
logger.warn(`⚠️ Order already completed. Skipping.`);
return { success: true, alreadyProcessed: true };
}

const balance = await getWalletBalance(order.coinSymbol, order.network);
if (balance < order.cryptoAmount) {
order.status = 'failed';
order.failureReason = `Insufficient balance: Have ${balance}, Need ${order.cryptoAmount}`;
logger.error(`❌ Insufficient balance for ${order.coinSymbol}`);
await updateSheetRow(order.tx_ref, { status: 'failed' });
return { success: false, error: order.failureReason };
}

const txResult = await sendCryptoFromWallet(
order.coinSymbol,
order.walletAddress,
order.cryptoAmount,
order.network
);

if (txResult.success) {
order.status = 'completed';
order.txId = txResult.txId;
order.explorerUrl = txResult.explorerUrl;
order.completedAt = new Date().toISOString();
order.paymentData = paymentData;

await updateSheetRow(order.tx_ref, {
status: 'completed',
txId: txResult.txId,
explorerUrl: txResult.explorerUrl,
completedAt: order.completedAt,
paymentData: JSON.stringify(paymentData || {})
});

logger.info(`✅ Order completed! TxID: ${txResult.txId}`);
return { success: true, txId: txResult.txId };
} else {
order.status = 'failed';
order.failureReason = txResult.error;
order.completedAt = new Date().toISOString();

await updateSheetRow(order.tx_ref, {
status: 'failed',
completedAt: order.completedAt
});

logger.error(`❌ Failed to send crypto: ${txResult.error}`);
return { success: false, error: txResult.error };
}

} catch (error) {
logger.error('❌ Process order error:', error.message);
order.status = 'failed';
order.failureReason = error.message;

await updateSheetRow(order.tx_ref, {
status: 'failed',
completedAt: new Date().toISOString()
});

return { success: false, error: error.message };
}
}

// ============================================================
// 📌 API ENDPOINTS
// ============================================================

// In-memory fallback
const orders = {};

app.post('/api/check-balance', async (req, res) => {
try {
const { coinSymbol, network, amount } = req.body;
const comingSoon = ['LTC', 'XRP', 'LINK'];
if (comingSoon.includes(coinSymbol)) {
return res.status(400).json({
success: false,
error: `${coinSymbol} is coming soon! Please choose another coin.`
});
}
const balance = await getWalletBalance(coinSymbol, network);
const hasBalance = balance >= amount;

res.json({
success: true,
hasBalance: hasBalance,
balance: balance,
requested: amount
});
} catch (error) {
logger.error('❌ Balance check error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.post('/api/create-payment', async (req, res) => {
try {
const {
coinSymbol,
cryptoAmount,
walletAddress,
network,
email,
name,
amountUSD,
nairaRate
} = req.body;

const comingSoon = ['LTC', 'XRP', 'LINK'];
if (comingSoon.includes(coinSymbol)) {
return res.status(400).json({
success: false,
error: `${coinSymbol} is coming soon! Please choose another coin.`
});
}

const tx_ref = 'DP' + Date.now();
const amountNGN = Math.round(amountUSD * nairaRate);

const balance = await getWalletBalance(coinSymbol, network);
if (balance < cryptoAmount) {
return res.status(400).json({
success: false,
error: `Insufficient balance. Available: ${balance} ${coinSymbol}, Required: ${cryptoAmount} ${coinSymbol}`
});
}

const orderData = {
tx_ref,
coinSymbol,
cryptoAmount: parseFloat(cryptoAmount),
walletAddress,
network: network || 'Default',
amountUSD: parseFloat(amountUSD),
amountNGN: amountNGN,
status: 'pending',
createdAt: new Date().toISOString(),
email: email || 'customer@dubpay.com',
name: name || 'DubPay Customer'
};

await appendToSheet(tx_ref, orderData);
orders[tx_ref] = orderData;

logger.info(`📝 Order created: ${tx_ref}`);

const paymentData = {
tx_ref: tx_ref,
amount: amountNGN,
currency: "NGN",
redirect_url: `${FRONTEND_URL}/payment-status?tx_ref=${tx_ref}`,
payment_options: "card,banktransfer,ussd",
customer: {
email: email || 'customer@dubpay.com',
name: name || 'DubPay Customer'
},
customizations: {
title: "DubPay - Buy Crypto",
description: `${cryptoAmount} ${coinSymbol}`,
logo: "https://dubpay.com/logo.png"
},
meta: {
coinSymbol,
cryptoAmount,
walletAddress,
network: network || 'Default'
}
};

const response = await fetch('https://api.flutterwave.com/v3/payments', {
method: 'POST',
headers: {
'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`,
'Content-Type': 'application/json'
},
body: JSON.stringify(paymentData)
});

const data = await response.json();

if (data.status === 'success') {
res.json({
success: true,
paymentLink: data.data.link,
tx_ref: tx_ref
});
} else {
res.status(400).json({
success: false,
error: data.message || 'Payment creation failed'
});
}
} catch (error) {
logger.error('❌ Create payment error:', error.message);
res.status(500).json({ success: false, error: error.message });
}
});

app.get('/api/verify-payment', async (req, res) => {
try {
const { tx_ref } = req.query;

logger.info(`🔍 Verifying payment for: ${tx_ref}`);

if (!tx_ref) {
return res.status(400).json({ error: 'Missing transaction reference' });
}

let order = orders[tx_ref];
if (!order) {
const sheetOrders = await getOrdersFromSheet();
order = sheetOrders[tx_ref];
}

if (!order) {
logger.error(`❌ Order not found: ${tx_ref}`);
return res.status(404).json({
error: 'Order not found. Please contact support.',
tx_ref: tx_ref
});
}

logger.info(`✅ Order found: ${tx_ref}`);
logger.info(`📊 Order status: ${order.status}`);

const response = await fetch(`https://api.flutterwave.com/v3/transactions/${tx_ref}/verify`, {
headers: {
'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`
}
});

const data = await response.json();

if (data.status === 'success' && data.data.status === 'successful') {
order.status = 'verified';
await updateSheetRow(tx_ref, { status: 'verified' });
logger.info(`✅ Payment verified for: ${tx_ref}`);
res.json({
success: true,
message: 'Payment verified! Your crypto is being sent...',
order: order
});
} else if (order.status === 'completed') {
res.json({
success: true,
message: 'Crypto has been sent to your wallet!',
order: order
});
} else {
logger.info(`⏳ Payment not yet confirmed: ${tx_ref}`);
res.json({
success: false,
message: 'Payment not confirmed yet. Please check back later.',
order: order
});
}
} catch (error) {
logger.error('❌ Verify payment error:', error.message);
res.status(500).json({ error: error.message });
}
});

app.get('/api/order-status/:tx_ref', async (req, res) => {
try {
const tx_ref = req.params.tx_ref;

let order = orders[tx_ref];
if (!order) {
const sheetOrders = await getOrdersFromSheet();
order = sheetOrders[tx_ref];
}

if (!order) {
return res.status(404).json({ error: 'Order not found' });
}

res.json({
success: true,
order: order
});
} catch (error) {
res.status(500).json({ error: error.message });
}
});

app.post('/api/flutterwave-webhook', async (req, res) => {
try {
const signature = req.headers['verif-hash'];
if (signature !== FLUTTERWAVE_WEBHOOK_SECRET) {
logger.error('❌ Invalid webhook signature');
return res.status(401).send('Invalid signature');
}

const event = req.body;
logger.info(`📥 Webhook received: ${event.event}`);

if (event.event === 'charge.completed' && event.data.status === 'successful') {
const tx_ref = event.data.tx_ref;
logger.info(`✅ Payment successful for TX: ${tx_ref}`);

let order = orders[tx_ref];
if (!order) {
const sheetOrders = await getOrdersFromSheet();
order = sheetOrders[tx_ref];
}

if (!order) {
logger.error(`❌ Order not found: ${tx_ref}`);
return res.status(404).send('Order not found');
}

logger.info(`📊 Processing order: ${tx_ref}`);

const result = await processSuccessfulOrder(order, event.data);

if (result.success) {
logger.info(`✅ Order ${tx_ref} completed successfully!`);
} else {
logger.error(`❌ Order ${tx_ref} failed: ${result.error}`);
}

return res.status(200).send('Webhook processed');
}

res.status(200).send('Webhook received');
} catch (error) {
logger.error('❌ Webhook error:', error.message);
res.status(500).send('Webhook error');
}
});

app.get('/api/health', (req, res) => {
res.json({
status: 'ok',
message: 'DubPay Backend is running! 🚀',
googleSheets: GOOGLE_SHEETS_SPREADSHEET_ID ? '✅ Connected' : '⚠️ Not configured'
});
});

app.get('/api/banks', async (req, res) => {
try {
const response = await fetch('https://api.flutterwave.com/v3/banks/NG', {
headers: {
'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`,
'Content-Type': 'application/json'
}
});
const data = await response.json();
if (data.status === 'success' && data.data) {
const seen = new Set();
const uniqueBanks = data.data.filter(bank => {
const duplicate = seen.has(bank.code);
seen.add(bank.code);
return !duplicate;
});
res.json({ status: 'success', message: 'Banks fetched successfully', data: uniqueBanks });
} else {
res.status(400).json(data);
}
} catch (error) {
logger.error('❌ Banks fetch error:', error.message);
res.status(500).json({ error: error.message });
}
});

app.post('/api/resolve', async (req, res) => {
try {
const { accountNumber, bankCode } = req.body;
if (!accountNumber || !bankCode) {
return res.status(400).json({ status: 'error', message: 'Account number and bank code are required' });
}
const cleanAccount = accountNumber.toString().trim();
if (cleanAccount.length !== 10) {
return res.status(400).json({ status: 'error', message: 'Account number must be 10 digits' });
}
if (cleanAccount === '0000000000') {
return res.json({
status: 'success',
data: { account_name: 'Test User', account_number: '0000000000', bank_name: 'Test Bank' }
});
}
const response = await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
method: 'POST',
headers: {
'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`,
'Content-Type': 'application/json'
},
body: JSON.stringify({ account_number: cleanAccount, account_bank: bankCode })
});
const data = await response.json();
if (data.status === 'success' && data.data) {
res.json(data);
} else {
res.status(400).json({ status: 'error', message: data.message || 'Invalid account number' });
}
} catch (error) {
logger.error('❌ Resolve error:', error.message);
res.status(500).json({ status: 'error', message: error.message });
}
});

// ============================================================
// 📌 START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
logger.info(`\n✅ DubPay Backend is running on port ${PORT}`);
logger.info(`📍 Health check: http://localhost:${PORT}/api/health`);
logger.info(`📍 Banks endpoint: http://localhost:${PORT}/api/banks`);
logger.info(`📍 Resolve endpoint: http://localhost:${PORT}/api/resolve`);
logger.info(`📍 Create payment: http://localhost:${PORT}/api/create-payment`);
logger.info(`📍 Check balance: http://localhost:${PORT}/api/check-balance`);
logger.info(`📍 Verify payment: http://localhost:${PORT}/api/verify-payment`);
logger.info(`📍 Webhook: http://localhost:${PORT}/api/flutterwave-webhook`);
if (GOOGLE_SHEETS_SPREADSHEET_ID) {
logger.info(`✅ Google Sheets connected: ${GOOGLE_SHEETS_SPREADSHEET_ID}`);
} else {
logger.warn(`⚠️ Google Sheets NOT configured. Orders will NOT be saved permanently.`);
}
logger.info(`\n`);
});

module.exports = app;
