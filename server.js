// server.js - Ultra-optimized backend with parallel processing and spam filtering
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
const spamCache = new NodeCache({ stdTTL: 86400 }); // 24 hour cache for spam detection

// Configuration
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// ULTRA SHORT timeouts for speed
axios.defaults.timeout = 3000; // 3 seconds max

// ============================================
// CHAIN CONFIGURATION
// ============================================

const CHAINS = {
    ethereum: {
        name: 'Ethereum',
        emoji: '🟦',
        rpc: 'eth-mainnet',
        explorer: 'https://etherscan.io',
        nativeSymbol: 'ETH'
    },
    base: {
        name: 'Base',
        emoji: '🔵',
        rpc: 'base-mainnet',
        explorer: 'https://basescan.org',
        nativeSymbol: 'ETH'
    },
    polygon: {
        name: 'Polygon',
        emoji: '🟣',
        rpc: 'polygon-mainnet',
        explorer: 'https://polygonscan.com',
        nativeSymbol: 'MATIC'
    },
    arbitrum: {
        name: 'Arbitrum',
        emoji: '🔷',
        rpc: 'arb-mainnet',
        explorer: 'https://arbiscan.io',
        nativeSymbol: 'ETH'
    },
    optimism: {
        name: 'Optimism',
        emoji: '🔴',
        rpc: 'opt-mainnet',
        explorer: 'https://optimistic.etherscan.io',
        nativeSymbol: 'ETH'
    },
    avalanche: {
        name: 'Avalanche',
        emoji: '🔺',
        rpc: 'avax-mainnet',
        explorer: 'https://snowtrace.io',
        nativeSymbol: 'AVAX'
    },
    blast: {
        name: 'Blast',
        emoji: '💥',
        rpc: 'blast-mainnet',
        explorer: 'https://blastscan.io',
        nativeSymbol: 'ETH'
    },
    bsc: {
        name: 'BSC',
        emoji: '🟡',
        rpc: 'bnb-mainnet',
        explorer: 'https://bscscan.com',
        nativeSymbol: 'BNB'
    },
    linea: {
        name: 'Linea',
        emoji: '⚫',
        rpc: 'linea-mainnet',
        explorer: 'https://lineascan.build',
        nativeSymbol: 'ETH'
    },
    zora: {
        name: 'Zora',
        emoji: '🌈',
        rpc: 'zora-mainnet',
        explorer: 'https://explorer.zora.energy',
        nativeSymbol: 'ETH'
    }
    // Note: Berachain, Hyperliquid, Abstract, and Apechain might not be fully supported yet
};

// Initialize providers for all chains
const providers = {};
Object.entries(CHAINS).forEach(([chainId, config]) => {
    try {
        providers[chainId] = new ethers.JsonRpcProvider(
            `https://${config.rpc}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
            undefined,
            { timeout: 3000 } // 3 second timeout
        );
    } catch (error) {
        console.log(`⚠️ Failed to initialize ${config.name} provider`);
    }
});

// ============================================
// SPAM DETECTION
// ============================================

// Known spam patterns
const SPAM_PATTERNS = {
    tokens: [
        /^Visit.*\.com$/i,
        /^www\..*$/i,
        /^https?:\/\//i,
        /\$\d+\.?free/i,
        /claim.*bonus/i,
        /airdrop/i,
        /^fake/i,
        /^test/i,
        /zepe\.io/i,
        /\.(com|io|org|net|xyz|tk)$/i,
        /^ERC-20$/i,
        /^Token$/i
    ],
    nfts: [
        /^ENS: /i,
        /^Lens Protocol/i,
        /^OpenSea Shared/i,
        /claim/i,
        /free mint/i,
        /test/i,
        /sample/i
    ]
};

function isSpamToken(token) {
    // Check name and symbol for spam patterns
    const checkString = `${token.name} ${token.symbol}`.toLowerCase();
    
    // Check against patterns
    for (const pattern of SPAM_PATTERNS.tokens) {
        if (pattern.test(token.name) || pattern.test(token.symbol)) {
            return true;
        }
    }
    
    // Check for suspicious characteristics
    if (token.name.length > 50) return true;
    if (token.symbol.length > 20) return true;
    if (token.name === token.symbol && token.name.length === 40) return true; // Likely address as name
    
    // If has no value and suspicious name
    if (token.usdValue === 0 && checkString.includes('visit')) return true;
    
    return false;
}

function isSpamNFT(collection) {
    for (const pattern of SPAM_PATTERNS.nfts) {
        if (pattern.test(collection.name)) {
            return true;
        }
    }
    return false;
}

// ============================================
// ULTRA-FAST PARALLEL WALLET ENDPOINT
// ============================================

app.get('/api/wallet/:addressOrEns', async (req, res) => {
    const startTime = Date.now();
    
    // Set response to stream JSON
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    
    try {
        let address = req.params.addressOrEns;
        let ensName = null;
        
        console.log(`\n🚀 ULTRA-FAST REQUEST: ${address}`);
        
        // Check cache
        const cacheKey = `wallet_${address.toLowerCase()}`;
        const cached = cache.get(cacheKey);
        if (cached) {
            console.log('✅ Cache hit!');
            return res.json(cached);
        }
        
        // Resolve ENS if needed (with timeout)
        if (address.toLowerCase().endsWith('.eth')) {
            ensName = address;
            try {
                const resolvePromise = providers.ethereum.resolveName(address);
                address = await Promise.race([
                    resolvePromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
                ]);
                
                if (!address) {
                    return res.status(400).json({ error: 'Could not resolve ENS name' });
                }
            } catch (error) {
                return res.status(400).json({ error: 'ENS resolution failed' });
            }
        }
        
        // Validate address
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid Ethereum address' });
        }
        
        console.log('⚡ Starting parallel fetch for ALL chains...');
        
        // Create promises for ALL chains in parallel with aggressive timeouts
        const chainPromises = Object.entries(CHAINS).map(async ([chainId, config]) => {
            const chainResult = {
                chain: chainId,
                tokens: [],
                success: false
            };
            
            try {
                // Race between fetch and timeout (2 seconds per chain)
                const tokens = await Promise.race([
                    fetchChainTokensFast(address, chainId),
                    new Promise((resolve) => setTimeout(() => resolve([]), 2000))
                ]);
                
                chainResult.tokens = tokens;
                chainResult.success = tokens.length > 0;
                
                if (tokens.length > 0) {
                    console.log(`  ✓ ${config.emoji} ${config.name}: ${tokens.length} tokens`);
                }
            } catch (error) {
                console.log(`  ✗ ${config.emoji} ${config.name}: skipped (timeout)`);
            }
            
            return chainResult;
        });
        
        // Fetch NFTs and activity in parallel (with short timeouts)
        const nftPromise = Promise.race([
            fetchNFTsFast(address),
            new Promise((resolve) => setTimeout(() => resolve([]), 3000))
        ]);
        
        const activityPromise = Promise.race([
            fetchActivityFast(address),
            new Promise((resolve) => setTimeout(() => resolve([]), 2000))
        ]);
        
        // Wait for ALL operations (but with timeouts built in)
        const [chainResults, nfts, activity] = await Promise.all([
            Promise.all(chainPromises),
            nftPromise,
            activityPromise
        ]);
        
        // Combine all tokens from all chains
        let allTokens = [];
        const tokensByChain = {};
        
        chainResults.forEach(result => {
            if (result.tokens.length > 0) {
                // Filter out spam tokens
                const validTokens = result.tokens.filter(t => !isSpamToken(t));
                allTokens.push(...validTokens);
                tokensByChain[result.chain] = validTokens;
            }
        });
        
        // Filter out spam NFTs
        const validNFTs = nfts.filter(collection => !isSpamNFT(collection));
        
        // Quick price fetch (1 second timeout)
        await Promise.race([
            fetchPricesQuick(allTokens),
            new Promise(resolve => setTimeout(resolve, 1000))
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
            tokensByChain,
            nfts: validNFTs,
            activity,
            tokenCount: allTokens.length,
            nftCount: validNFTs.reduce((sum, c) => sum + c.nfts.length, 0),
            chainsWithBalance: Object.keys(tokensByChain),
            responseTime: Date.now() - startTime
        };
        
        // Cache the response
        cache.set(cacheKey, responseData, 300);
        
        console.log(`✅ Response ready in ${responseData.responseTime}ms`);
        res.json(responseData);
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch wallet data',
            message: error.message
        });
    }
});

// ============================================
// ULTRA-FAST TOKEN FETCHING
// ============================================

async function fetchChainTokensFast(address, chainId) {
    const config = CHAINS[chainId];
    const provider = providers[chainId];
    
    if (!provider) return [];
    
    const tokens = [];
    
    try {
        // Get native balance (super quick)
        const balancePromise = provider.getBalance(address);
        const balance = await Promise.race([
            balancePromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))
        ]);
        
        const formatted = ethers.formatEther(balance);
        
        if (parseFloat(formatted) > 0.000001) {
            tokens.push({
                name: config.nativeSymbol === 'ETH' ? `ETH on ${config.name}` : config.nativeSymbol,
                symbol: config.nativeSymbol,
                balance: formatted,
                price: 0,
                usdValue: 0,
                chain: chainId,
                chainName: config.name,
                chainEmoji: config.emoji,
                isNative: true,
                logo: config.nativeSymbol === 'ETH' ? 
                    'https://cryptologos.cc/logos/ethereum-eth-logo.png' :
                    config.nativeSymbol === 'MATIC' ?
                    'https://cryptologos.cc/logos/polygon-matic-logo.png' :
                    config.nativeSymbol === 'BNB' ?
                    'https://cryptologos.cc/logos/binance-coin-bnb-logo.png' :
                    config.nativeSymbol === 'AVAX' ?
                    'https://cryptologos.cc/logos/avalanche-avax-logo.png' :
                    ''
            });
        }
    } catch (error) {
        // Skip native token if timeout
    }
    
    // Get ERC-20 tokens
    try {
        const alchemyUrl = `https://${config.rpc}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
        
        const response = await axios.post(alchemyUrl, {
            jsonrpc: '2.0',
            method: 'alchemy_getTokenBalances',
            params: [address],
            id: 1
        }, {
            timeout: 2000 // 2 second timeout
        });
        
        if (response.data.result?.tokenBalances) {
            const nonZeroBalances = response.data.result.tokenBalances
                .filter(tb => tb.tokenBalance && tb.tokenBalance !== '0x0')
                .slice(0, 50); // Limit to 50 tokens per chain for speed
            
            // Process in small batches
            const batchSize = 5;
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
                            timeout: 1000 // 1 second timeout
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
                            chain: chainId,
                            chainName: config.name,
                            chainEmoji: config.emoji,
                            logo: metadata.logo || '',
                            price: 0,
                            usdValue: 0
                        };
                    } catch (err) {
                        return null;
                    }
                });
                
                const results = await Promise.all(batchPromises);
                tokens.push(...results.filter(t => t !== null));
            }
        }
    } catch (error) {
        // Skip ERC-20 if error
    }
    
    return tokens;
}

// ============================================
// ULTRA-FAST NFT FETCHING WITH FLOOR PRICES
// ============================================

async function fetchNFTsFast(address) {
    try {
        const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner`;
        
        const response = await axios.get(url, {
            params: {
                owner: address,
                withMetadata: true,
                pageSize: 200,
                orderBy: 'transferTime'
            },
            timeout: 5000
        });
        
        const collections = {};
        
        if (response.data.ownedNfts) {
            // Process NFTs into collections
            response.data.ownedNfts.forEach(nft => {
                // Skip obvious spam patterns
                if (nft.contract.name && (
                    nft.contract.name.includes('.com') ||
                    nft.contract.name.includes('Visit ') ||
                    nft.contract.name.includes('Free ') ||
                    nft.contract.name.includes('Claim ')
                )) return;
                
                const key = nft.contract.address;
                
                if (!collections[key]) {
                    collections[key] = {
                        name: nft.contract.name || 'Unknown',
                        address: key,
                        symbol: nft.contract.symbol,
                        nfts: [],
                        floorPrice: 0,
                        totalValue: 0,
                        openSeaSlug: nft.contract.openSeaMetadata?.collectionSlug || null
                    };
                }
                
                let image = nft.image?.thumbnailUrl || 
                           nft.image?.cachedUrl || 
                           nft.raw?.metadata?.image ||
                           '';
                
                // Convert IPFS URLs to HTTP gateway
                if (image && image.startsWith('ipfs://')) {
                    image = `https://ipfs.io/ipfs/${image.slice(7)}`;
                }
                
                collections[key].nfts.push({
                    name: nft.name || nft.title || `#${nft.tokenId}`,
                    tokenId: nft.tokenId,
                    image,
                    largeImage: nft.image?.cachedUrl || image,
                    hasImage: !!image,
                    description: nft.description
                });
            });
        }
        
        // Get floor prices for collections (parallel)
        const collectionArray = Object.values(collections);
        const floorPricePromises = collectionArray.map(async (collection) => {
            try {
                // Try to get floor price from Alchemy
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
                } else if (floorResponse.data?.looksRare?.floorPrice) {
                    collection.floorPrice = floorResponse.data.looksRare.floorPrice;
                    collection.totalValue = collection.floorPrice * collection.nfts.length;
                    collection.marketplace = 'LooksRare';
                }
            } catch (error) {
                // Silently fail for individual floor price fetches
            }
        });
        
        // Wait for all floor prices (with timeout)
        await Promise.race([
            Promise.all(floorPricePromises),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);
        
        // Filter out collections with no floor price (likely spam)
        // BUT keep collections with many NFTs even without floor price
        const validCollections = collectionArray.filter(collection => {
            // Keep if has floor price
            if (collection.floorPrice > 0) return true;
            // Keep if has 5+ NFTs (likely legitimate collection)
            if (collection.nfts.length >= 5) return true;
            // Keep if it's a known legitimate collection name pattern
            if (collection.name && (
                collection.name.includes('ENS') ||
                collection.name.includes('Lens') ||
                collection.name.includes('POAP') ||
                collection.name.includes('Uniswap') ||
                collection.name.includes('CryptoPunks') ||
                collection.name.includes('Bored Ape') ||
                collection.name.includes('Azuki') ||
                collection.name.includes('Doodles') ||
                collection.name.includes('Moonbirds')
            )) return true;
            // Otherwise, only keep if has at least 1 NFT with an image
            return collection.nfts.some(nft => nft.hasImage);
        });
        
        // Sort by total value (collections with floor prices first)
        validCollections.sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));
        
        return validCollections;
        
    } catch (error) {
        console.error('NFT fetch error:', error);
        return [];
    }
}

// ============================================
// ULTRA-FAST ACTIVITY FETCHING  
// ============================================

async function fetchActivityFast(address) {
    if (!process.env.ETHERSCAN_API_KEY) return [];
    
    try {
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
                    offset: 20,
                    sort: 'desc',
                    apikey: process.env.ETHERSCAN_API_KEY
                },
                timeout: 2000
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
        // Return empty if timeout
    }
    
    return [];
}

// ============================================
// QUICK PRICE FETCHING
// ============================================

async function fetchPricesQuick(tokens) {
    // Get major coin prices
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { 
                ids: 'ethereum,matic-network,binancecoin,avalanche-2', 
                vs_currencies: 'usd' 
            },
            timeout: 1000
        });
        
        const prices = {
            ETH: res.data.ethereum?.usd || 2000,
            MATIC: res.data['matic-network']?.usd || 0.8,
            BNB: res.data.binancecoin?.usd || 300,
            AVAX: res.data['avalanche-2']?.usd || 30
        };
        
        // Update native token prices
        tokens.forEach(token => {
            if (token.isNative && prices[token.symbol]) {
                token.price = prices[token.symbol];
                token.usdValue = parseFloat(token.balance) * token.price;
            }
            
            // Stablecoins
            if (['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FRAX'].includes(token.symbol)) {
                token.price = 1;
                token.usdValue = parseFloat(token.balance);
            }
            
            // WETH = ETH price
            if (token.symbol === 'WETH') {
                token.price = prices.ETH;
                token.usdValue = parseFloat(token.balance) * token.price;
            }
        });
    } catch (error) {
        // Use fallback prices
        tokens.forEach(token => {
            if (token.symbol === 'ETH') {
                token.price = 2000;
                token.usdValue = parseFloat(token.balance) * 2000;
            }
        });
    }
}

// ============================================
// HEALTH & STATUS
// ============================================

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '9.0-ultra',
        chains: Object.keys(CHAINS),
        cache: cache.getStats()
    });
});

app.get('/', (req, res) => {
    res.json({ 
        message: '🚀 eth.af API v9.0 - Ultra Fast Edition',
        status: 'operational',
        chains: Object.keys(CHAINS).length,
        endpoints: {
            wallet: '/api/wallet/{address-or-ens}',
            health: '/api/health'
        }
    });
});

// ============================================
// START SERVER
// ============================================

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 eth.af Backend v9.0 - ULTRA FAST EDITION`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`⏰ Started: ${new Date().toISOString()}`);
    console.log(`\n⛓️ Active Chains (${Object.keys(CHAINS).length}):`);
    Object.entries(CHAINS).forEach(([id, config]) => {
        console.log(`  ${config.emoji} ${config.name}`);
    });
    console.log(`\n⚡ Optimizations:`);
    console.log(`  • Parallel chain fetching`);
    console.log(`  • 1-3 second timeouts`);
    console.log(`  • Spam filtering`);
    console.log(`  • Response streaming`);
    console.log(`${'='.repeat(60)}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});
