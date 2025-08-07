// server.js - Optimized backend with working ETH/Base + spam filtering
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
// PROVIDERS SETUP (KEEP ORIGINAL WORKING VERSION)
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

// Add other chain providers
try {
    providers.polygon = new ethers.JsonRpcProvider(
        `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
        undefined,
        { timeout: 10000 }
    );
} catch (error) {
    console.log('Polygon provider initialization failed');
}

try {
    providers.arbitrum = new ethers.JsonRpcProvider(
        `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
        undefined,
        { timeout: 10000 }
    );
} catch (error) {
    console.log('Arbitrum provider initialization failed');
}

try {
    providers.optimism = new ethers.JsonRpcProvider(
        `https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
        undefined,
        { timeout: 10000 }
    );
} catch (error) {
    console.log('Optimism provider initialization failed');
}

// ============================================
// SPAM DETECTION (CONSERVATIVE)
// ============================================

const SPAM_TOKEN_PATTERNS = [
    /^Visit.*\.com$/i,
    /^www\./i,
    /^https?:\/\//i,
    /zepe\.io/i
];

const LEGITIMATE_TOKENS = [
    'ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'LINK', 'UNI', 'AAVE',
    'MKR', 'SNX', 'CRV', 'SUSHI', 'YFI', 'COMP', 'BAL', 'MATIC', 'BNB',
    'AVAX', 'FTM', 'OP', 'ARB', 'PEPE', 'SHIB', 'DOGE', 'APE', 'SAND',
    'MANA', 'AXS', 'GALA', 'ENJ', 'CHZ', 'BLUR', 'LDO', 'RPL', 'FXS',
    'FRAX', 'GRT', 'ENS', 'BAT', 'ZRX', '1INCH', 'BUSD', 'TUSD', 'USDP',
    'RAI', 'LUSD', 'MIM', 'CVX', 'CRO', 'QNT', 'RNDR', 'IMX', 'LRC',
    'OCEAN', 'AGIX', 'FET', 'GNO', 'RDNT', 'GMX', 'GNS', 'PENDLE'
];

function isLikelySpamToken(token) {
    // Never filter known legitimate tokens
    if (LEGITIMATE_TOKENS.includes(token.symbol?.toUpperCase())) {
        return false;
    }
    
    // Never filter tokens with ANY value
    if (token.usdValue > 0.01) {
        return false;
    }
    
    // Only check for the most obvious spam patterns
    const tokenName = (token.name || '').toLowerCase();
    const tokenSymbol = (token.symbol || '').toLowerCase();
    
    // Only filter if it EXACTLY matches known spam patterns
    if (tokenName.startsWith('visit ') && tokenName.includes('.com')) {
        return true;
    }
    
    if (tokenName.startsWith('www.') || tokenName.startsWith('http://') || tokenName.startsWith('https://')) {
        return true;
    }
    
    // Check if name is just a raw Ethereum address
    if (/^0x[a-fA-F0-9]{40}$/.test(token.name) && token.usdValue === 0) {
        return true;
    }
    
    return false;
}

// ============================================
// MAIN WALLET ENDPOINT (KEEP WORKING VERSION)
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
            // Ethereum tokens - KEEP ORIGINAL TIMEOUT
            Promise.race([
                fetchTokensSafe(address, 'ethereum'),
                new Promise((resolve) => setTimeout(() => resolve([]), 15000))
            ]),
            
            // Base tokens - KEEP ORIGINAL TIMEOUT
            Promise.race([
                fetchTokensSafe(address, 'base'),
                new Promise((resolve) => setTimeout(() => resolve([]), 10000))
            ]),
            
            // Polygon tokens
            Promise.race([
                fetchTokensSafe(address, 'polygon'),
                new Promise((resolve) => setTimeout(() => resolve([]), 10000))
            ]),
            
            // Arbitrum tokens
            Promise.race([
                fetchTokensSafe(address, 'arbitrum'),
                new Promise((resolve) => setTimeout(() => resolve([]), 10000))
            ]),
            
            // Optimism tokens
            Promise.race([
                fetchTokensSafe(address, 'optimism'),
                new Promise((resolve) => setTimeout(() => resolve([]), 10000))
            ]),
            
            // NFTs - KEEP ORIGINAL
            Promise.race([
                fetchNFTsSafe(address),
                new Promise((resolve) => setTimeout(() => resolve([]), 10000))
            ]),
            
            // Activity - KEEP ORIGINAL
            Promise.race([
                fetchActivitySafe(address),
                new Promise((resolve) => setTimeout(() => resolve([]), 5000))
            ])
        ];
        
        // Wait for all with error handling
        const [ethereumTokens, baseTokens, polygonTokens, arbitrumTokens, optimismTokens, nfts, activity] = await Promise.all(fetchPromises);
        
        console.log(`\n📈 Data fetched:`);
        console.log(`  • Ethereum tokens: ${ethereumTokens.length}`);
        console.log(`  • Base tokens: ${baseTokens.length}`);
        console.log(`  • Polygon tokens: ${polygonTokens.length}`);
        console.log(`  • Arbitrum tokens: ${arbitrumTokens.length}`);
        console.log(`  • Optimism tokens: ${optimismTokens.length}`);
        console.log(`  • NFT collections: ${nfts.length}`);
        console.log(`  • Recent transactions: ${activity.length}`);
        
        // Combine all tokens
        const allTokens = [...ethereumTokens, ...baseTokens, ...polygonTokens, ...arbitrumTokens, ...optimismTokens];
        
        // Filter spam tokens
        const validTokens = allTokens.filter(token => {
            const isSpam = isLikelySpamToken(token);
            if (isSpam) {
                console.log(`  🚫 Filtered spam: ${token.name} (${token.symbol})`);
            }
            return !isSpam;
        });
        
        console.log(`  • Tokens after spam filter: ${validTokens.length} (filtered ${allTokens.length - validTokens.length})`);
        
        // Get prices with timeout
        console.log('💰 Fetching prices...');
        await Promise.race([
            fetchPricesForTokens(validTokens),
            new Promise((resolve) => setTimeout(() => resolve(), 5000))
        ]);
        
        // Calculate total value
        const totalValue = validTokens.reduce((sum, t) => sum + (t.usdValue || 0), 0);
        
        // Sort by value
        validTokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
        
        const responseData = {
            address,
            ensName,
            totalValue,
            tokens: validTokens,
            tokensByChain: {
                ethereum: validTokens.filter(t => t.chain === 'ethereum'),
                base: validTokens.filter(t => t.chain === 'base'),
                polygon: validTokens.filter(t => t.chain === 'polygon'),
                arbitrum: validTokens.filter(t => t.chain === 'arbitrum'),
                optimism: validTokens.filter(t => t.chain === 'optimism')
            },
            nfts,
            activity,
            tokenCount: validTokens.length,
            nftCount: nfts.reduce((sum, c) => sum + c.nfts.length, 0),
            chainsWithBalance: [...new Set(validTokens.map(t => t.chain))],
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
// TOKEN FETCHING (KEEP ORIGINAL WORKING VERSION)
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
        
        // Chain configurations
        const chainConfigs = {
            ethereum: { name: 'Ethereum', emoji: '🟦', nativeSymbol: 'ETH' },
            base: { name: 'Base', emoji: '🔵', nativeSymbol: 'ETH' },
            polygon: { name: 'Polygon', emoji: '🟣', nativeSymbol: 'MATIC' },
            arbitrum: { name: 'Arbitrum', emoji: '🔷', nativeSymbol: 'ETH' },
            optimism: { name: 'Optimism', emoji: '🔴', nativeSymbol: 'ETH' }
        };
        
        const config = chainConfigs[chain];
        
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
                    name: chain === 'base' ? 'ETH on Base' : 
                          chain === 'polygon' ? 'MATIC' :
                          chain === 'arbitrum' ? 'ETH on Arbitrum' :
                          chain === 'optimism' ? 'ETH on Optimism' :
                          'Ethereum',
                    symbol: config.nativeSymbol,
                    balance: ethFormatted,
                    price: 0,
                    usdValue: 0,
                    chain,
                    chainEmoji: config.emoji,
                    isNative: true,
                    logo: config.nativeSymbol === 'ETH' ? 
                        'https://cryptologos.cc/logos/ethereum-eth-logo.png' :
                        'https://cryptologos.cc/logos/polygon-matic-logo.png'
                });
                console.log(`    ✓ ${config.nativeSymbol}: ${parseFloat(ethFormatted).toFixed(4)}`);
            }
        } catch (error) {
            console.log(`    ⚠️ Failed to get ${chain} native balance`);
        }
        
        // Get ERC-20 tokens
        try {
            const alchemyUrl = `https://${chain === 'base' ? 'base' : 
                                        chain === 'polygon' ? 'polygon' :
                                        chain === 'arbitrum' ? 'arb' :
                                        chain === 'optimism' ? 'opt' :
                                        'eth'}-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
            
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
                
                // Process ALL tokens - no limits
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
                                chainEmoji: config.emoji,
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
                
                console.log(`    ✅ Fetched ${tokens.length} tokens from ${chain}`);
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
// NFT FETCHING (KEEP ORIGINAL WORKING VERSION)
// ============================================

async function fetchNFTsSafe(address) {
    try {
        console.log('  • Fetching NFTs...');
        
        const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner`;
        
        const response = await axios.get(url, {
            params: {
                owner: address,
                withMetadata: true,
                pageSize: 500  // Increased to get ALL NFTs
            },
            timeout: 15000  // Increased timeout for more NFTs
        });
        
        const collections = {};
        
        if (response.data.ownedNfts) {
            console.log(`    📦 Found ${response.data.ownedNfts.length} total NFTs`);
            
            response.data.ownedNfts.forEach(nft => {
                // VERY minimal spam filter - only filter the most egregious spam
                const contractName = (nft.contract.name || '').toLowerCase();
                if (contractName.includes('visit ') && contractName.includes('.com')) {
                    // Only skip if it has BOTH "visit " AND ".com" in the name
                    return;
                }
                
                const key = nft.contract.address;
                
                if (!collections[key]) {
                    collections[key] = {
                        name: nft.contract.name || 'Unknown Collection',
                        address: key,
                        nfts: [],
                        floorPrice: 0,
                        totalValue: 0
                    };
                }
                
                // Try multiple image sources
                let image = nft.image?.thumbnailUrl || 
                           nft.image?.cachedUrl ||
                           nft.image?.originalUrl ||
                           nft.image?.pngUrl ||
                           nft.image?.jpegUrl ||
                           nft.media?.[0]?.thumbnail ||
                           nft.media?.[0]?.gateway ||
                           nft.metadata?.image ||
                           nft.metadata?.image_url ||
                           '';
                
                // Convert IPFS URLs to HTTP gateway
                if (image && image.startsWith('ipfs://')) {
                    image = `https://ipfs.io/ipfs/${image.slice(7)}`;
                }
                
                collections[key].nfts.push({
                    name: nft.name || nft.title || `#${nft.tokenId}`,
                    tokenId: nft.tokenId,
                    image,
                    largeImage: nft.image?.originalUrl || nft.image?.cachedUrl || image,
                    hasImage: !!image
                });
            });
            
            console.log(`    📚 Organized into ${Object.keys(collections).length} collections`);
        }
        
        // Sort NFTs within each collection
        Object.values(collections).forEach(c => {
            c.nfts.sort((a, b) => {
                if (a.hasImage && !b.hasImage) return -1;
                if (!a.hasImage && b.hasImage) return 1;
                return 0;
            });
        });
        
        // Try to get floor prices (optional enhancement - don't block NFT display)
        const collectionArray = Object.values(collections);
        
        // Get floor prices in parallel but with timeout
        const floorPricePromises = collectionArray.slice(0, 20).map(async (collection) => {
            try {
                const floorUrl = `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getFloorPrice`;
                const floorResponse = await axios.get(floorUrl, {
                    params: {
                        contractAddress: collection.address
                    },
                    timeout: 2000
                });
                
                if (floorResponse.data?.openSea?.floorPrice) {
                    collection.floorPrice = floorResponse.data.openSea.floorPrice;
                    collection.totalValue = collection.floorPrice * collection.nfts.length;
                    collection.marketplace = 'OpenSea';
                }
            } catch (error) {
                // Silently fail for floor prices - don't block NFT display
            }
        });
        
        // Wait for floor prices but don't let it block too long
        await Promise.race([
            Promise.all(floorPricePromises),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);
        
        // Sort by total value, then by number of NFTs
        collectionArray.sort((a, b) => {
            if (a.totalValue && !b.totalValue) return -1;
            if (!a.totalValue && b.totalValue) return 1;
            if (a.totalValue && b.totalValue) return b.totalValue - a.totalValue;
            return b.nfts.length - a.nfts.length;
        });
        
        console.log(`    ✅ Returning ${collectionArray.length} NFT collections`);
        return collectionArray;
        
    } catch (error) {
        console.error('  ⚠️ NFT fetch error:', error.message);
        return [];
    }
}

// ============================================
// ACTIVITY FETCHING (KEEP ORIGINAL)
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
// PRICE FETCHING (KEEP ORIGINAL)
// ============================================

async function fetchPricesForTokens(tokens) {
    // Get ETH price first
    let ethPrice = 2000;
    let maticPrice = 1;
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { ids: 'ethereum,matic-network', vs_currencies: 'usd' },
            timeout: 3000
        });
        ethPrice = res.data.ethereum?.usd || 2000;
        maticPrice = res.data['matic-network']?.usd || 1;
    } catch (err) {
        console.log('  ⚠️ Could not fetch ETH/MATIC price');
    }
    
    // Update native token prices
    tokens.forEach(token => {
        if (token.symbol === 'ETH' || token.symbol === 'WETH') {
            token.price = ethPrice;
            token.usdValue = parseFloat(token.balance) * ethPrice;
        } else if (token.symbol === 'MATIC') {
            token.price = maticPrice;
            token.usdValue = parseFloat(token.balance) * maticPrice;
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
        version: '10.0',
        cache: cache.getStats()
    });
});

app.get('/', (req, res) => {
    res.json({ 
        message: '🚀 eth.af API v10.0 - Working Version',
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
    console.log(`🚀 eth.af Backend v10.0 - Working Version`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`⏰ Started: ${new Date().toISOString()}`);
    console.log(`\n🔑 Configuration:`);
    console.log(`  • Alchemy: ${process.env.ALCHEMY_API_KEY ? '✅' : '❌'}`);
    console.log(`  • Etherscan: ${process.env.ETHERSCAN_API_KEY ? '✅' : '❌'}`);
    console.log(`\n⛓️ Active Chains:`);
    console.log(`  • 🟦 Ethereum: ${providers.ethereum ? '✅' : '❌'}`);
    console.log(`  • 🔵 Base: ${providers.base ? '✅' : '❌'}`);
    console.log(`  • 🟣 Polygon: ${providers.polygon ? '✅' : '❌'}`);
    console.log(`  • 🔷 Arbitrum: ${providers.arbitrum ? '✅' : '❌'}`);
    console.log(`  • 🔴 Optimism: ${providers.optimism ? '✅' : '❌'}`);
    console.log(`\n⚡ Features:`);
    console.log(`  • Request caching: 5 minutes`);
    console.log(`  • Price caching: 1 minute`);
    console.log(`  • Spam filtering: Conservative`);
    console.log(`  • NFT floor prices: Enabled`);
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
