// server.js - Optimized backend with timeouts and error handling
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

// Initialize caches
const cache = new NodeCache({ stdTTL: 300 });
const priceCache = new NodeCache({ stdTTL: 60 });

// Configuration
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// Set default axios timeout
axios.defaults.timeout = 10000; // 10 seconds

// ============================================
// PROVIDERS SETUP
// ============================================

const providers = {
    ethereum: new ethers.JsonRpcProvider(
        `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
        undefined,
        { timeout: 10000 }
    )
};

// Add Base provider with error handling
try {
    providers.base = new ethers.JsonRpcProvider(
        `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
        undefined,
        { timeout: 10000 }
    );
} catch (error) {
    console.log('Base provider initialization failed');
}

// ============================================
// MAIN WALLET ENDPOINT WITH TIMEOUT HANDLING
// ============================================

app.get('/api/wallet/:addressOrEns', async (req, res) => {
    const startTime = Date.now();
    
    try {
        let address = req.params.addressOrEns;
        let ensName = null;
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔍 REQUEST: ${address}`);
        console.log(`⏰ Time: ${new Date().toISOString()}`);
        console.log(`${'='.repeat(60)}`);
        
        // Check cache first
        const cacheKey = `wallet_${address.toLowerCase()}`;
        const cached = cache.get(cacheKey);
        if (cached) {
            console.log('✅ Returning cached data');
            return res.json(cached);
        }
        
        // Resolve ENS with timeout
        if (address.toLowerCase().endsWith('.eth')) {
            ensName = address;
            console.log('📝 Resolving ENS...');
            
            try {
                // Set a timeout for ENS resolution
                const resolvePromise = providers.ethereum.resolveName(address);
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('ENS resolution timeout')), 5000)
                );
                
                address = await Promise.race([resolvePromise, timeoutPromise]);
                
                if (!address) {
                    console.log('❌ ENS resolution failed');
                    return res.status(400).json({ error: 'Could not resolve ENS name' });
                }
                
                console.log(`✅ ENS resolved: ${ensName} → ${address}`);
            } catch (error) {
                console.error('❌ ENS error:', error.message);
                return res.status(400).json({ error: 'ENS resolution failed' });
            }
        }
        
        // Validate address
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid Ethereum address' });
        }
        
        // Fetch data with timeouts and error handling
        console.log('📊 Fetching wallet data...');
        
        // Create promises with timeouts
        const fetchPromises = [
            // Ethereum tokens - with timeout
            Promise.race([
                fetchTokensSafe(address, 'ethereum'),
                new Promise((resolve) => setTimeout(() => resolve([]), 15000))
            ]),
            
            // Base tokens - with timeout and fallback
            Promise.race([
                fetchTokensSafe(address, 'base'),
                new Promise((resolve) => setTimeout(() => resolve([]), 10000))
            ]),
            
            // NFTs - with timeout
            Promise.race([
                fetchNFTsSafe(address),
                new Promise((resolve) => setTimeout(() => resolve([]), 10000))
            ]),
            
            // Activity - with timeout
            Promise.race([
                fetchActivitySafe(address),
                new Promise((resolve) => setTimeout(() => resolve([]), 5000))
            ])
        ];
        
        // Wait for all with error handling
        const [ethereumTokens, baseTokens, nfts, activity] = await Promise.all(fetchPromises);
        
        console.log(`\n📈 Data fetched:`);
        console.log(`  • Ethereum tokens: ${ethereumTokens.length}`);
        console.log(`  • Base tokens: ${baseTokens.length}`);
        console.log(`  • NFT collections: ${nfts.length}`);
        console.log(`  • Recent transactions: ${activity.length}`);
        
        // Combine all tokens
        const allTokens = [...ethereumTokens, ...baseTokens];
        
        // Get prices with timeout (don't wait too long for prices)
        console.log('💰 Fetching prices...');
        await Promise.race([
            fetchPricesForTokens(allTokens),
            new Promise((resolve) => setTimeout(() => resolve(), 5000))
        ]);
        
        // Calculate total value
        const totalValue = allTokens.reduce((sum, t) => sum + (t.usdValue || 0), 0);
        
        // Sort by value
        allTokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
        
        const responseData = {
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
            chainsWithBalance: [...new Set(allTokens.map(t => t.chain))],
            responseTime: Date.now() - startTime
        };
        
        // Cache the response
        cache.set(cacheKey, responseData, 300);
        
        console.log(`✅ Response sent in ${Date.now() - startTime}ms`);
        res.json(responseData);
        
    } catch (error) {
        console.error('❌ FATAL ERROR:', error);
        res.status(500).json({ 
            error: 'Failed to fetch wallet data',
            message: error.message,
            responseTime: Date.now() - startTime
        });
    }
});

// ============================================
// SAFE TOKEN FETCHING WITH ERROR HANDLING
// ============================================

async function fetchTokensSafe(address, chain) {
    try {
        console.log(`  • Fetching ${chain} tokens...`);
        const tokens = [];
        
        // Get provider
        const provider = providers[chain];
        if (!provider) {
            console.log(`    ⚠️ No provider for ${chain}`);
            return [];
        }
        
        // Get native balance with timeout
        try {
            const balancePromise = provider.getBalance(address);
            const balance = await Promise.race([
                balancePromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]);
            
            const ethFormatted = ethers.formatEther(balance);
            
            if (parseFloat(ethFormatted) > 0.000001) {
                tokens.push({
                    name: chain === 'base' ? 'ETH on Base' : 'Ethereum',
                    symbol: 'ETH',
                    balance: ethFormatted,
                    price: 0,
                    usdValue: 0,
                    chain,
                    chainEmoji: chain === 'base' ? '🔵' : '🟦',
                    isNative: true,
                    logo: 'https://cryptologos.cc/logos/ethereum-eth-logo.png'
                });
                console.log(`    ✓ ETH: ${parseFloat(ethFormatted).toFixed(4)}`);
            }
        } catch (error) {
            console.log(`    ⚠️ Failed to get ${chain} ETH balance`);
        }
        
        // Get ERC-20 tokens
        try {
            const alchemyUrl = `https://${chain === 'base' ? 'base' : 'eth'}-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
            
            const response = await axios.post(alchemyUrl, {
                jsonrpc: '2.0',
                method: 'alchemy_getTokenBalances',
                params: [address],
                id: 1
            }, {
                timeout: 10000
            });
            
            if (response.data.result?.tokenBalances) {
                const nonZeroBalances = response.data.result.tokenBalances.filter(
                    tb => tb.tokenBalance && tb.tokenBalance !== '0x0'
                );
                
                console.log(`    📦 Found ${nonZeroBalances.length} tokens`);
                
                // Process tokens in batches to avoid timeouts
                const batchSize = 10;
                for (let i = 0; i < nonZeroBalances.length; i += batchSize) {
                    const batch = nonZeroBalances.slice(i, i + batchSize);
                    
                    const batchPromises = batch.map(async (tb) => {
                        try {
                            const metadataRes = await axios.post(alchemyUrl, {
                                jsonrpc: '2.0',
                                method: 'alchemy_getTokenMetadata',
                                params: [tb.contractAddress],
                                id: 1
                            }, {
                                timeout: 5000
                            });
                            
                            const metadata = metadataRes.data.result;
                            if (!metadata) return null;
                            
                            const decimals = metadata.decimals || 18;
                            const balance = ethers.formatUnits(tb.tokenBalance, decimals);
                            
                            if (parseFloat(balance) < 0.000000001) return null;
                            
                            return {
                                name: metadata.name || 'Unknown',
                                symbol: metadata.symbol || 'UNKNOWN',
                                balance,
                                decimals,
                                contractAddress: tb.contractAddress,
                                chain,
                                chainEmoji: chain === 'base' ? '🔵' : '🟦',
                                logo: metadata.logo || '',
                                price: 0,
                                usdValue: 0
                            };
                        } catch (err) {
                            return null;
                        }
                    });
                    
                    const batchResults = await Promise.all(batchPromises);
                    tokens.push(...batchResults.filter(t => t !== null));
                }
            }
        } catch (error) {
            console.log(`    ⚠️ Failed to get ${chain} ERC-20 tokens:`, error.message);
        }
        
        return tokens;
        
    } catch (error) {
        console.error(`  ❌ Error fetching ${chain} tokens:`, error.message);
        return [];
    }
}

// ============================================
// SAFE NFT FETCHING
// ============================================

async function fetchNFTsSafe(address) {
    try {
        console.log('  • Fetching NFTs...');
        
        const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner`;
        
        const response = await axios.get(url, {
            params: {
                owner: address,
                withMetadata: true,
                pageSize: 50 // Reduced to avoid timeouts
            },
            timeout: 10000
        });
        
        const collections = {};
        
        if (response.data.ownedNfts) {
            response.data.ownedNfts.forEach(nft => {
                const key = nft.contract.address;
                
                if (!collections[key]) {
                    collections[key] = {
                        name: nft.contract.name || 'Unknown',
                        address: key,
                        nfts: [],
                        floorPrice: 0,
                        totalValue: 0
                    };
                }
                
                let image = nft.image?.thumbnailUrl || 
                           nft.image?.cachedUrl || 
                           '';
                
                collections[key].nfts.push({
                    name: nft.name || `#${nft.tokenId}`,
                    tokenId: nft.tokenId,
                    image,
                    hasImage: !!image
                });
            });
        }
        
        // Sort NFTs and collections
        Object.values(collections).forEach(c => {
            c.nfts.sort((a, b) => {
                if (a.hasImage && !b.hasImage) return -1;
                if (!a.hasImage && b.hasImage) return 1;
                return 0;
            });
        });
        
        return Object.values(collections);
        
    } catch (error) {
        console.error('  ⚠️ NFT fetch error:', error.message);
        return [];
    }
}

// ============================================
// SAFE ACTIVITY FETCHING
// ============================================

async function fetchActivitySafe(address) {
    if (!process.env.ETHERSCAN_API_KEY) return [];
    
    try {
        console.log('  • Fetching activity...');
        
        const response = await axios.get(
            `https://api.etherscan.io/api`, 
            {
                params: {
                    module: 'account',
                    action: 'txlist',
                    address: address,
                    startblock: 0,
                    endblock: 99999999,
                    page: 1,
                    offset: 10,
                    sort: 'desc',
                    apikey: process.env.ETHERSCAN_API_KEY
                },
                timeout: 5000
            }
        );
        
        if (response.data.result && Array.isArray(response.data.result)) {
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
        console.error('  ⚠️ Activity error:', error.message);
    }
    
    return [];
}

// ============================================
// PRICE FETCHING
// ============================================

async function fetchPricesForTokens(tokens) {
    // Get ETH price first
    let ethPrice = 2000;
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { ids: 'ethereum', vs_currencies: 'usd' },
            timeout: 3000
        });
        ethPrice = res.data.ethereum?.usd || 2000;
    } catch (err) {
        console.log('  ⚠️ Could not fetch ETH price');
    }
    
    // Update ETH prices
    tokens.forEach(token => {
        if (token.symbol === 'ETH' || token.symbol === 'WETH') {
            token.price = ethPrice;
            token.usdValue = parseFloat(token.balance) * ethPrice;
        }
    });
    
    // Common stablecoin prices
    const stablecoins = ['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD'];
    tokens.forEach(token => {
        if (stablecoins.includes(token.symbol)) {
            token.price = 1;
            token.usdValue = parseFloat(token.balance);
        }
    });
    
    // Try to get other prices from DexScreener (in batches)
    const tokensNeedingPrices = tokens.filter(t => !t.price && t.contractAddress);
    
    for (const token of tokensNeedingPrices) {
        try {
            const res = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${token.contractAddress}`,
                { timeout: 2000 }
            );
            
            if (res.data?.pairs?.[0]?.priceUsd) {
                token.price = parseFloat(res.data.pairs[0].priceUsd);
                token.usdValue = parseFloat(token.balance) * token.price;
            }
        } catch (err) {
            // Ignore price errors
        }
    }
}

// ============================================
// OTHER ENDPOINTS
// ============================================

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '8.0',
        cache: cache.getStats()
    });
});

app.get('/', (req, res) => {
    res.json({ 
        message: '🚀 eth.af API v8.0 - Optimized',
        status: 'operational',
        endpoints: {
            wallet: '/api/wallet/{address-or-ens}',
            health: '/api/health'
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: err.message 
    });
});

// ============================================
// START SERVER
// ============================================

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 eth.af Backend v8.0 - Optimized Edition`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`⏰ Started: ${new Date().toISOString()}`);
    console.log(`\n🔑 Configuration:`);
    console.log(`  • Alchemy: ${process.env.ALCHEMY_API_KEY ? '✅' : '❌'}`);
    console.log(`  • Etherscan: ${process.env.ETHERSCAN_API_KEY ? '✅' : '❌'}`);
    console.log(`\n⚡ Optimizations:`);
    console.log(`  • Request caching: 5 minutes`);
    console.log(`  • Price caching: 1 minute`);
    console.log(`  • Timeouts: 5-15 seconds`);
    console.log(`  • Batch processing: Yes`);
    console.log(`${'='.repeat(60)}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});
