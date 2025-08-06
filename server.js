// server.js - Enhanced with better token detection and debugging
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

// Initialize cache
const cache = new NodeCache({ stdTTL: 300 });
const priceCache = new NodeCache({ stdTTL: 60 });

// Configuration
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// Providers
const providers = {
    ethereum: new ethers.JsonRpcProvider(
        `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    ),
    base: new ethers.JsonRpcProvider(
        `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    )
};

// ============================================
// Helper Functions
// ============================================

async function resolveENS(ensName) {
    try {
        const address = await providers.ethereum.resolveName(ensName);
        return address;
    } catch (error) {
        console.error('ENS resolution error:', error.message);
        return null;
    }
}

// ============================================
// Main Wallet Endpoint
// ============================================

app.get('/api/wallet/:addressOrEns', async (req, res) => {
    try {
        let address = req.params.addressOrEns;
        let ensName = null;
        
        console.log(`\n${'='.repeat(50)}`);
        console.log(`🔍 FETCHING WALLET: ${address}`);
        console.log(`${'='.repeat(50)}`);
        
        // Resolve ENS
        if (address.toLowerCase().endsWith('.eth')) {
            ensName = address;
            address = await resolveENS(address);
            if (!address) {
                return res.status(400).json({ error: 'Invalid ENS name' });
            }
            console.log(`✅ ENS resolved: ${ensName} → ${address}`);
        }
        
        // Validate address
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid Ethereum address' });
        }
        
        // Fetch all data
        const [ethereumData, baseData, nfts, activity] = await Promise.all([
            getCompleteTokenList(address, 'ethereum'),
            getCompleteTokenList(address, 'base'),
            getNFTsWithFloorPrice(address),
            getRecentTransactions(address)
        ]);
        
        console.log(`\n📊 RESULTS SUMMARY:`);
        console.log(`  • Ethereum tokens: ${ethereumData.length}`);
        console.log(`  • Base tokens: ${baseData.length}`);
        console.log(`  • NFT collections: ${nfts.length}`);
        
        // Combine and process all tokens
        const allTokens = [...ethereumData, ...baseData];
        let totalValue = 0;
        
        // Calculate total value
        allTokens.forEach(token => {
            totalValue += token.usdValue || 0;
        });
        
        // Sort tokens by value
        allTokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
        
        console.log(`\n💰 Total Portfolio Value: $${totalValue.toFixed(2)}`);
        
        res.json({
            address,
            ensName,
            totalValue,
            tokens: allTokens,
            tokensByChain: {
                ethereum: allTokens.filter(t => t.chain === 'ethereum'),
                base: allTokens.filter(t => t.chain === 'base')
            },
            nfts,
            activity,
            tokenCount: allTokens.length,
            nftCount: nfts.reduce((sum, c) => sum + c.nfts.length, 0),
            chainsWithBalance: [...new Set(allTokens.map(t => t.chain))]
        });
        
    } catch (error) {
        console.error('❌ ERROR:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// Complete Token Fetching with Prices
// ============================================

async function getCompleteTokenList(address, chain) {
    console.log(`\n🔗 Fetching tokens for ${chain}...`);
    
    const tokens = [];
    const alchemyKey = process.env.ALCHEMY_API_KEY;
    
    if (!alchemyKey) {
        console.error('❌ No Alchemy API key!');
        return [];
    }
    
    try {
        // Get native balance
        const provider = providers[chain];
        const ethBalance = await provider.getBalance(address);
        const ethFormatted = ethers.formatEther(ethBalance);
        
        if (parseFloat(ethFormatted) > 0) {
            const ethPrice = await getTokenPrice('ETH');
            tokens.push({
                name: chain === 'base' ? 'ETH on Base' : 'Ethereum',
                symbol: 'ETH',
                balance: ethFormatted,
                price: ethPrice,
                usdValue: parseFloat(ethFormatted) * ethPrice,
                chain,
                chainEmoji: chain === 'base' ? '🔵' : '🟦',
                isNative: true,
                logo: 'https://cryptologos.cc/logos/ethereum-eth-logo.png'
            });
            console.log(`  ✓ ETH Balance: ${ethFormatted} ($${(parseFloat(ethFormatted) * ethPrice).toFixed(2)})`);
        }
        
        // Get all ERC-20 tokens
        const alchemyUrl = `https://${chain === 'base' ? 'base' : 'eth'}-mainnet.g.alchemy.com/v2/${alchemyKey}`;
        
        // Method 1: Get token balances
        const balancesResponse = await axios.post(alchemyUrl, {
            jsonrpc: '2.0',
            method: 'alchemy_getTokenBalances',
            params: [address],
            id: 1
        });
        
        if (balancesResponse.data.result?.tokenBalances) {
            const tokenBalances = balancesResponse.data.result.tokenBalances.filter(
                tb => tb.tokenBalance && tb.tokenBalance !== '0x0'
            );
            
            console.log(`  📦 Found ${tokenBalances.length} tokens with balances`);
            
            // Get metadata and prices for each token
            for (const tb of tokenBalances) {
                try {
                    // Get token metadata
                    const metadataRes = await axios.post(alchemyUrl, {
                        jsonrpc: '2.0',
                        method: 'alchemy_getTokenMetadata',
                        params: [tb.contractAddress],
                        id: 1
                    });
                    
                    const metadata = metadataRes.data.result;
                    if (!metadata) continue;
                    
                    const decimals = metadata.decimals || 18;
                    const balance = ethers.formatUnits(tb.tokenBalance, decimals);
                    
                    if (parseFloat(balance) === 0) continue;
                    
                    // Get price
                    let price = 0;
                    let usdValue = 0;
                    
                    // Try multiple price sources
                    price = await getTokenPrice(metadata.symbol, tb.contractAddress, chain);
                    usdValue = parseFloat(balance) * price;
                    
                    tokens.push({
                        name: metadata.name || 'Unknown',
                        symbol: metadata.symbol || '???',
                        balance: balance,
                        price: price,
                        usdValue: usdValue,
                        chain,
                        chainEmoji: chain === 'base' ? '🔵' : '🟦',
                        contractAddress: tb.contractAddress,
                        logo: metadata.logo || '',
                        decimals
                    });
                    
                    console.log(`  ✓ ${metadata.symbol}: ${parseFloat(balance).toFixed(4)} ($${usdValue.toFixed(2)})`);
                    
                } catch (err) {
                    console.error(`  ⚠️ Error processing token ${tb.contractAddress}:`, err.message);
                }
            }
        }
        
    } catch (error) {
        console.error(`❌ Error fetching ${chain} tokens:`, error.message);
    }
    
    return tokens;
}

// ============================================
// Token Price Fetching
// ============================================

async function getTokenPrice(symbol, contractAddress = null, chain = 'ethereum') {
    // Common token prices
    const staticPrices = {
        'ETH': 2000,
        'WETH': 2000,
        'USDC': 1,
        'USDT': 1,
        'DAI': 1,
        'WBTC': 45000
    };
    
    if (staticPrices[symbol?.toUpperCase()]) {
        return staticPrices[symbol.toUpperCase()];
    }
    
    // If we have contract address, try DEX prices
    if (contractAddress) {
        try {
            // Try 1inch API
            const chainId = chain === 'base' ? 8453 : 1;
            const url = `https://api.1inch.dev/price/v1.1/${chainId}/${contractAddress}`;
            
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${process.env.ONEINCH_API_KEY || ''}`
                },
                timeout: 3000
            });
            
            if (response.data && response.data[contractAddress]) {
                const priceInUSD = parseFloat(response.data[contractAddress]);
                if (priceInUSD > 0) {
                    console.log(`    💵 Found 1inch price for ${symbol}: $${priceInUSD}`);
                    return priceInUSD;
                }
            }
        } catch (err) {
            // Try DexScreener as fallback
            try {
                const dexRes = await axios.get(
                    `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
                    { timeout: 3000 }
                );
                
                if (dexRes.data?.pairs?.[0]?.priceUsd) {
                    const price = parseFloat(dexRes.data.pairs[0].priceUsd);
                    console.log(`    💵 Found DexScreener price for ${symbol}: $${price}`);
                    return price;
                }
            } catch (e) {
                // No price found
            }
        }
    }
    
    // Try CoinGecko for symbol
    try {
        const cgResponse = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price',
            {
                params: {
                    ids: symbol.toLowerCase(),
                    vs_currencies: 'usd'
                },
                timeout: 3000
            }
        );
        
        if (cgResponse.data[symbol.toLowerCase()]) {
            return cgResponse.data[symbol.toLowerCase()].usd;
        }
    } catch (err) {
        // No CoinGecko price
    }
    
    console.log(`    ⚠️ No price found for ${symbol}`);
    return 0;
}

// ============================================
// NFT Fetching with Floor Prices
// ============================================

async function getNFTsWithFloorPrice(address) {
    try {
        const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner`;
        
        const response = await axios.get(url, {
            params: {
                owner: address,
                withMetadata: true,
                pageSize: 100
            }
        });
        
        const collections = {};
        
        if (response.data.ownedNfts) {
            // Group by collection
            response.data.ownedNfts.forEach(nft => {
                const key = nft.contract.address;
                
                if (!collections[key]) {
                    collections[key] = {
                        name: nft.contract.name || 'Unknown',
                        address: nft.contract.address,
                        nfts: [],
                        floorPrice: 0,
                        totalValue: 0
                    };
                }
                
                let image = nft.image?.cachedUrl || 
                           nft.image?.thumbnailUrl || 
                           nft.image?.originalUrl || '';
                           
                if (image?.startsWith('ipfs://')) {
                    image = `https://ipfs.io/ipfs/${image.slice(7)}`;
                }
                
                collections[key].nfts.push({
                    name: nft.name || `#${nft.tokenId}`,
                    tokenId: nft.tokenId,
                    image,
                    hasImage: !!image
                });
            });
        }
        
        // Get floor prices and calculate values
        for (const collection of Object.values(collections)) {
            try {
                const floorRes = await axios.post(
                    `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getFloorPrice`,
                    { contractAddress: collection.address }
                );
                
                if (floorRes.data?.openSea?.floorPrice) {
                    collection.floorPrice = floorRes.data.openSea.floorPrice;
                    collection.totalValue = collection.floorPrice * collection.nfts.length;
                }
            } catch (err) {
                // No floor price available
            }
            
            // Sort NFTs: images first
            collection.nfts.sort((a, b) => {
                if (a.hasImage && !b.hasImage) return -1;
                if (!a.hasImage && b.hasImage) return 1;
                return 0;
            });
        }
        
        // Sort collections by total value (highest first)
        return Object.values(collections).sort((a, b) => b.totalValue - a.totalValue);
        
    } catch (error) {
        console.error('NFT fetch error:', error);
        return [];
    }
}

// ============================================
// Recent Transactions
// ============================================

async function getRecentTransactions(address) {
    if (!process.env.ETHERSCAN_API_KEY) return [];
    
    try {
        const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc&apikey=${process.env.ETHERSCAN_API_KEY}`;
        
        const response = await axios.get(url);
        
        if (response.data.result) {
            return response.data.result.map(tx => ({
                hash: tx.hash,
                from: tx.from,
                to: tx.to,
                value: ethers.formatEther(tx.value || '0'),
                timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
                method: tx.functionName?.split('(')[0] || 'Transfer'
            }));
        }
    } catch (error) {
        console.error('Activity error:', error);
    }
    
    return [];
}

// ============================================
// Debug Endpoint
// ============================================

app.get('/api/debug/:address/:chain', async (req, res) => {
    const { address, chain } = req.params;
    
    console.log(`\n🐛 DEBUG MODE for ${address} on ${chain}`);
    
    try {
        const alchemyUrl = `https://${chain === 'base' ? 'base' : 'eth'}-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
        
        // Get raw token balances
        const response = await axios.post(alchemyUrl, {
            jsonrpc: '2.0',
            method: 'alchemy_getTokenBalances',
            params: [address],
            id: 1
        });
        
        const tokens = [];
        
        if (response.data.result?.tokenBalances) {
            for (const tb of response.data.result.tokenBalances) {
                if (tb.tokenBalance === '0x0') continue;
                
                // Get metadata
                const metaRes = await axios.post(alchemyUrl, {
                    jsonrpc: '2.0',
                    method: 'alchemy_getTokenMetadata',
                    params: [tb.contractAddress],
                    id: 1
                });
                
                const meta = metaRes.data.result;
                const balance = ethers.formatUnits(tb.tokenBalance, meta?.decimals || 18);
                
                tokens.push({
                    contract: tb.contractAddress,
                    symbol: meta?.symbol,
                    name: meta?.name,
                    balance: balance,
                    rawBalance: tb.tokenBalance,
                    decimals: meta?.decimals
                });
            }
        }
        
        res.json({
            chain,
            address,
            tokenCount: tokens.length,
            tokens
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Root
app.get('/', (req, res) => {
    res.json({ 
        message: 'eth.af API v6.0',
        endpoints: {
            wallet: '/api/wallet/{address}',
            debug: '/api/debug/{address}/{chain}'
        }
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 eth.af Backend v6.0 - Debug Edition`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🔑 Alchemy: ${process.env.ALCHEMY_API_KEY ? '✅' : '❌'}`);
    console.log(`🔑 Etherscan: ${process.env.ETHERSCAN_API_KEY ? '✅' : '❌'}`);
    console.log(`${'='.repeat(50)}\n`);
});

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
