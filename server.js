// server.js - Enhanced Multi-Chain Backend with Ethereum & Base L2
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

// Initialize cache (TTL: 5 minutes)
const cache = new NodeCache({ stdTTL: 300 });

// Railway/Render configuration
app.set('trust proxy', true);
app.enable('trust proxy');

// Middleware
app.use(cors());
app.use(express.json());

// Initialize providers for Ethereum and Base
const providers = {
    ethereum: new ethers.JsonRpcProvider(
        process.env.ETHEREUM_RPC_URL || 
        `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    ),
    base: new ethers.JsonRpcProvider(
        `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    )
};

// Chain configurations with fun emojis
const chainConfigs = {
    ethereum: { 
        id: 1, 
        name: 'Ethereum', 
        displayName: 'Ethereum Mainnet',
        emoji: '🟦',
        color: '#627EEA',
        explorer: 'etherscan.io', 
        nativeCurrency: 'ETH',
        alchemyPrefix: 'eth-mainnet'
    },
    base: { 
        id: 8453, 
        name: 'Base', 
        displayName: 'Base L2',
        emoji: '🔵',
        color: '#0052FF',
        explorer: 'basescan.org', 
        nativeCurrency: 'ETH',
        alchemyPrefix: 'base-mainnet'
    }
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

function isValidAddress(address) {
    return ethers.isAddress(address);
}

async function getCachedData(key, fetchFunction) {
    const cached = cache.get(key);
    if (cached) {
        console.log(`Cache hit for ${key}`);
        return cached;
    }
    
    console.log(`Cache miss for ${key}, fetching...`);
    try {
        const data = await fetchFunction();
        if (data) cache.set(key, data);
        return data;
    } catch (error) {
        console.error(`Error fetching ${key}:`, error.message);
        return null;
    }
}

// ============================================
// API Routes
// ============================================

// Root route with fun ASCII art
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'online',
        message: '🚀 eth.af API is running!',
        version: '3.0',
        features: [
            '💎 ALL ERC-20 tokens',
            '🌐 Ethereum + Base L2',
            '🖼️ NFT images with tabs',
            '🎨 Fun & clean design'
        ],
        supportedChains: Object.keys(chainConfigs).map(chain => ({
            name: chainConfigs[chain].displayName,
            emoji: chainConfigs[chain].emoji
        })),
        endpoints: {
            health: '/api/health',
            wallet: '/api/wallet/{address-or-ens}',
            example: '/api/wallet/vitalik.eth'
        }
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        port: PORT,
        message: '🟢 All systems operational!'
    });
});

// Main wallet endpoint with multi-chain support
app.get('/api/wallet/:addressOrEns', async (req, res) => {
    try {
        let address = req.params.addressOrEns;
        let ensName = null;
        console.log(`[${new Date().toISOString()}] 🔍 Fetching wallet: ${address}`);
        
        // Resolve ENS if needed
        if (address.toLowerCase().endsWith('.eth')) {
            ensName = address;
            const resolved = await resolveENS(address);
            if (!resolved) {
                return res.status(400).json({ error: 'Invalid ENS name' });
            }
            address = resolved;
            console.log(`✅ ENS resolved: ${ensName} → ${address}`);
        }
        
        // Validate address
        if (!isValidAddress(address)) {
            return res.status(400).json({ error: 'Invalid Ethereum address' });
        }
        
        // Fetch data from both chains in parallel
        console.log('⛓️ Fetching from Ethereum and Base...');
        const [ethereumTokens, baseTokens, nfts, prices] = await Promise.all([
            getAllTokensForChain(address, 'ethereum'),
            getAllTokensForChain(address, 'base'),
            getEnhancedNFTs(address),
            getComprehensiveTokenPrices()
        ]);
        
        // Combine all tokens with chain info
        const allTokens = [];
        let totalValue = 0;
        
        // Process Ethereum tokens
        ethereumTokens.forEach(token => {
            const price = prices[token.symbol?.toUpperCase()] || prices[token.symbol?.toLowerCase()] || 0;
            const usdValue = parseFloat(token.balance || 0) * price;
            totalValue += usdValue;
            allTokens.push({
                ...token,
                chain: 'ethereum',
                chainEmoji: chainConfigs.ethereum.emoji,
                chainColor: chainConfigs.ethereum.color,
                price,
                usdValue,
                displayBalance: formatTokenBalance(token.balance, token.symbol)
            });
        });
        
        // Process Base tokens
        baseTokens.forEach(token => {
            const price = prices[token.symbol?.toUpperCase()] || prices[token.symbol?.toLowerCase()] || 0;
            const usdValue = parseFloat(token.balance || 0) * price;
            totalValue += usdValue;
            allTokens.push({
                ...token,
                chain: 'base',
                chainEmoji: chainConfigs.base.emoji,
                chainColor: chainConfigs.base.color,
                price,
                usdValue,
                displayBalance: formatTokenBalance(token.balance, token.symbol)
            });
        });
        
        // Filter out dust and sort by USD value
        const significantTokens = allTokens
            .filter(token => token.balance > 0.000001 || token.usdValue > 0.01)
            .sort((a, b) => b.usdValue - a.usdValue);
        
        res.status(200).json({
            address,
            ensName,
            totalValue,
            tokens: significantTokens,
            tokensByChain: {
                ethereum: significantTokens.filter(t => t.chain === 'ethereum'),
                base: significantTokens.filter(t => t.chain === 'base')
            },
            nfts: nfts || [],
            tokenCount: significantTokens.length,
            nftCount: (nfts || []).reduce((sum, collection) => sum + collection.nfts.length, 0),
            chainsWithBalance: [...new Set(significantTokens.map(t => t.chain))],
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Wallet endpoint error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch wallet data', 
            details: error.message 
        });
    }
});

// Get ALL tokens for a specific chain
async function getAllTokensForChain(address, chain) {
    const cacheKey = `all_tokens_${chain}_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            const tokens = [];
            const provider = providers[chain];
            const config = chainConfigs[chain];
            
            if (!provider || !process.env.ALCHEMY_API_KEY) {
                console.warn(`⚠️ No provider for ${chain}`);
                return [];
            }
            
            // Get native ETH balance
            console.log(`💰 Getting ${config.nativeCurrency} balance on ${chain}...`);
            const ethBalance = await provider.getBalance(address);
            tokens.push({
                name: config.nativeCurrency === 'ETH' ? 'Ethereum' : config.nativeCurrency,
                symbol: config.nativeCurrency,
                balance: ethers.formatEther(ethBalance),
                decimals: 18,
                logo: 'https://cryptologos.cc/logos/ethereum-eth-logo.png',
                isNative: true,
                chain: chain
            });
            
            // Get ALL ERC-20 tokens using Alchemy
            const alchemyUrl = `https://${config.alchemyPrefix}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
            
            console.log(`🔍 Fetching all ERC-20 tokens on ${chain}...`);
            const response = await axios.post(alchemyUrl, {
                jsonrpc: '2.0',
                method: 'alchemy_getTokenBalances',
                params: [address],
                id: 1
            });
            
            if (response.data.result && response.data.result.tokenBalances) {
                // Filter tokens with non-zero balance
                const tokenBalances = response.data.result.tokenBalances.filter(
                    tb => tb.tokenBalance !== '0x0' && tb.tokenBalance !== '0x'
                );
                
                console.log(`📊 Found ${tokenBalances.length} tokens with balance on ${chain}`);
                
                // Fetch metadata for each token
                for (const tokenBalance of tokenBalances) {
                    try {
                        const metadataResponse = await axios.post(alchemyUrl, {
                            jsonrpc: '2.0',
                            method: 'alchemy_getTokenMetadata',
                            params: [tokenBalance.contractAddress],
                            id: 1
                        });
                        
                        const metadata = metadataResponse.data.result;
                        if (!metadata) continue;
                        
                        const balance = parseInt(tokenBalance.tokenBalance, 16);
                        const decimals = metadata.decimals || 18;
                        const formattedBalance = ethers.formatUnits(balance, decimals);
                        
                        // Try multiple logo sources
                        let logo = metadata.logo || '';
                        if (!logo) {
                            // Try TrustWallet assets
                            logo = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chain === 'base' ? 'base' : 'ethereum'}/assets/${tokenBalance.contractAddress}/logo.png`;
                        }
                        
                        tokens.push({
                            name: metadata.name || 'Unknown Token',
                            symbol: metadata.symbol || 'UNKNOWN',
                            balance: formattedBalance,
                            decimals: decimals,
                            logo: logo,
                            contractAddress: tokenBalance.contractAddress,
                            isNative: false,
                            chain: chain
                        });
                    } catch (error) {
                        console.error(`⚠️ Error fetching metadata for ${tokenBalance.contractAddress} on ${chain}`);
                    }
                }
            }
            
            console.log(`✅ Total tokens found on ${chain}: ${tokens.length}`);
            return tokens;
            
        } catch (error) {
            console.error(`❌ Error fetching ${chain} tokens:`, error.message);
            return [];
        }
    });
}

// Enhanced NFT fetching with better images and metadata
async function getEnhancedNFTs(address) {
    const cacheKey = `enhanced_nfts_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            console.log('🎨 Fetching NFT collections...');
            
            // Fetch from both Ethereum and Base (Base NFTs if available)
            const nftPromises = [];
            
            // Ethereum NFTs
            nftPromises.push(fetchNFTsFromChain(address, 'ethereum'));
            
            // Base NFTs (if Base support is available)
            if (process.env.ALCHEMY_API_KEY) {
                nftPromises.push(fetchNFTsFromChain(address, 'base'));
            }
            
            const allNFTResults = await Promise.all(nftPromises);
            const allCollections = {};
            
            // Merge NFTs from all chains
            allNFTResults.forEach(collections => {
                Object.entries(collections).forEach(([name, collection]) => {
                    if (!allCollections[name]) {
                        allCollections[name] = collection;
                    } else {
                        // Merge NFTs from same collection across chains
                        allCollections[name].nfts.push(...collection.nfts);
                    }
                });
            });
            
            // Sort collections by NFT count
            const sortedCollections = Object.values(allCollections)
                .sort((a, b) => b.nfts.length - a.nfts.length);
            
            console.log(`✅ Found ${sortedCollections.length} NFT collections`);
            return sortedCollections;
            
        } catch (error) {
            console.error('❌ NFT fetch error:', error.message);
            return [];
        }
    });
}

// Fetch NFTs from a specific chain
async function fetchNFTsFromChain(address, chain) {
    try {
        const config = chainConfigs[chain];
        const url = `https://${config.alchemyPrefix}.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner`;
        
        const response = await axios.get(url, {
            params: {
                owner: address,
                withMetadata: true,
                pageSize: 100,
                orderBy: 'transferTime'
            }
        });
        
        const collections = {};
        
        if (response.data.ownedNfts) {
            response.data.ownedNfts.forEach(nft => {
                const collectionName = nft.contract.name || 'Unknown Collection';
                const collectionSymbol = nft.contract.symbol || '';
                const collectionKey = `${collectionName}_${chain}`;
                
                if (!collections[collectionKey]) {
                    collections[collectionKey] = {
                        name: collectionName,
                        symbol: collectionSymbol,
                        address: nft.contract.address,
                        chain: chain,
                        chainEmoji: config.emoji,
                        nfts: [],
                        floorPrice: null,
                        totalSupply: nft.contract.totalSupply
                    };
                }
                
                // Get the best available image
                let imageUrl = nft.image?.cachedUrl || 
                              nft.image?.thumbnailUrl || 
                              nft.image?.pngUrl ||
                              nft.image?.originalUrl ||
                              nft.media?.[0]?.gateway ||
                              nft.media?.[0]?.thumbnail ||
                              nft.media?.[0]?.raw ||
                              '';
                
                // Handle IPFS URLs
                if (imageUrl.startsWith('ipfs://')) {
                    imageUrl = `https://ipfs.io/ipfs/${imageUrl.slice(7)}`;
                }
                
                // Use Alchemy CDN for better performance
                if (imageUrl && !imageUrl.includes('alchemy')) {
                    // Alchemy can optimize images
                    imageUrl = nft.image?.thumbnailUrl || imageUrl;
                }
                
                collections[collectionKey].nfts.push({
                    name: nft.name || nft.title || `${collectionSymbol} #${nft.tokenId}`,
                    tokenId: nft.tokenId,
                    image: imageUrl,
                    description: nft.description,
                    attributes: nft.raw?.metadata?.attributes || [],
                    tokenType: nft.tokenType,
                    balance: nft.balance || 1,
                    chain: chain,
                    rarity: nft.rarity // If available
                });
            });
        }
        
        return collections;
        
    } catch (error) {
        console.error(`⚠️ Error fetching NFTs from ${chain}:`, error.message);
        return {};
    }
}

// Get comprehensive token prices
async function getComprehensiveTokenPrices() {
    const cacheKey = 'comprehensive_prices';
    
    return getCachedData(cacheKey, async () => {
        try {
            console.log('💵 Fetching token prices...');
            
            // Extended list of tokens to get prices for
            const tokenList = [
                'ethereum', 'wrapped-bitcoin', 'tether', 'usd-coin', 'binance-usd', 
                'dai', 'frax', 'true-usd', 'chainlink', 'uniswap', 'aave', 
                'curve-dao-token', 'maker', 'compound-governance-token', 'sushi',
                'the-graph', '1inch', 'matic-network', 'arbitrum', 'optimism',
                'lido-dao', 'rocket-pool', 'frax-share', 'convex-finance',
                'yearn-finance', 'synthetic-usd', 'balancer', 'pancakeswap-token',
                'ape-coin', 'the-sandbox', 'decentraland', 'axie-infinity',
                'immutable-x', 'gala', 'enjincoin', 'render-token', 
                'worldcoin', 'blur', 'floki', 'pepe', 'shiba-inu', 'bone',
                'baby-doge-coin', 'dogelon-mars', 'bitcoin', 'bnb'
            ];
            
            const url = 'https://api.coingecko.com/api/v3/simple/price';
            const response = await axios.get(url, {
                params: {
                    ids: tokenList.join(','),
                    vs_currencies: 'usd'
                }
            });
            
            // Create a comprehensive price map
            const priceMap = {
                // Native & Major tokens
                'ETH': response.data.ethereum?.usd || 2000,
                'WETH': response.data.ethereum?.usd || 2000,
                'WBTC': response.data['wrapped-bitcoin']?.usd || 45000,
                'BTC': response.data.bitcoin?.usd || 45000,
                
                // Stablecoins
                'USDT': response.data.tether?.usd || 1,
                'USDC': response.data['usd-coin']?.usd || 1,
                'DAI': response.data.dai?.usd || 1,
                'BUSD': response.data['binance-usd']?.usd || 1,
                'FRAX': response.data.frax?.usd || 1,
                'TUSD': response.data['true-usd']?.usd || 1,
                'SUSD': response.data['synthetic-usd']?.usd || 1,
                
                // DeFi tokens
                'LINK': response.data.chainlink?.usd || 10,
                'UNI': response.data.uniswap?.usd || 5,
                'AAVE': response.data.aave?.usd || 50,
                'CRV': response.data['curve-dao-token']?.usd || 1,
                'MKR': response.data.maker?.usd || 1000,
                'COMP': response.data['compound-governance-token']?.usd || 50,
                'SUSHI': response.data.sushi?.usd || 1,
                'GRT': response.data['the-graph']?.usd || 0.1,
                '1INCH': response.data['1inch']?.usd || 0.5,
                'YFI': response.data['yearn-finance']?.usd || 5000,
                'BAL': response.data.balancer?.usd || 5,
                'LDO': response.data['lido-dao']?.usd || 2,
                'RPL': response.data['rocket-pool']?.usd || 20,
                'FXS': response.data['frax-share']?.usd || 5,
                'CVX': response.data['convex-finance']?.usd || 3,
                
                // Layer 2 / Chain tokens
                'MATIC': response.data['matic-network']?.usd || 0.8,
                'ARB': response.data.arbitrum?.usd || 1,
                'OP': response.data.optimism?.usd || 1.5,
                'BNB': response.data.bnb?.usd || 300,
                
                // Gaming & Metaverse
                'APE': response.data['ape-coin']?.usd || 1,
                'SAND': response.data['the-sandbox']?.usd || 0.5,
                'MANA': response.data.decentraland?.usd || 0.5,
                'AXS': response.data['axie-infinity']?.usd || 5,
                'IMX': response.data['immutable-x']?.usd || 0.5,
                'GALA': response.data.gala?.usd || 0.02,
                'ENJ': response.data.enjincoin?.usd || 0.3,
                'RNDR': response.data['render-token']?.usd || 2,
                
                // Meme coins
                'SHIB': response.data['shiba-inu']?.usd || 0.000008,
                'PEPE': response.data.pepe?.usd || 0.0000001,
                'FLOKI': response.data.floki?.usd || 0.00003,
                'BONE': response.data.bone?.usd || 0.5,
                'BABYDOGE': response.data['baby-doge-coin']?.usd || 0.0000000001,
                'ELON': response.data['dogelon-mars']?.usd || 0.0000002,
                
                // Other popular tokens
                'WLD': response.data.worldcoin?.usd || 2,
                'BLUR': response.data.blur?.usd || 0.3,
                'CAKE': response.data['pancakeswap-token']?.usd || 2
            };
            
            console.log(`✅ Loaded prices for ${Object.keys(priceMap).length} tokens`);
            return priceMap;
            
        } catch (error) {
            console.error('⚠️ Price fetch error:', error.message);
            // Return basic fallback prices
            return {
                'ETH': 2000, 'WETH': 2000, 'USDC': 1, 'USDT': 1, 
                'DAI': 1, 'WBTC': 45000, 'LINK': 10, 'UNI': 5
            };
        }
    });
}

// Format token balance for display
function formatTokenBalance(balance, symbol) {
    const bal = parseFloat(balance);
    if (bal === 0) return '0';
    if (bal < 0.000001) return '<0.000001';
    if (bal < 0.01) return bal.toFixed(6);
    if (bal < 1) return bal.toFixed(4);
    if (bal < 10000) return bal.toFixed(2);
    if (bal < 1000000) return `${(bal / 1000).toFixed(2)}K`;
    if (bal < 1000000000) return `${(bal / 1000000).toFixed(2)}M`;
    return `${(bal / 1000000000).toFixed(2)}B`;
}

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Not Found',
        message: '🔍 The endpoint you\'re looking for doesn\'t exist!',
        availableEndpoints: {
            root: '/',
            health: '/api/health',
            wallet: '/api/wallet/{address-or-ens}'
        }
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║                                          ║');
    console.log('║     🚀 eth.af Multi-Chain Backend       ║');
    console.log('║           Version 3.0                    ║');
    console.log('║                                          ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log(`📡 Server running on port ${PORT}`);
    console.log('');
    console.log('✨ Features:');
    console.log('  • ALL ERC-20 tokens on Ethereum & Base');
    console.log('  • Enhanced NFT images with collections');
    console.log('  • ENS name resolution');
    console.log('  • Comprehensive token pricing');
    console.log('');
    console.log('🔑 API Keys:');
    console.log(`  • Etherscan: ${process.env.ETHERSCAN_API_KEY ? '✅ Connected' : '❌ Missing'}`);
    console.log(`  • Alchemy: ${process.env.ALCHEMY_API_KEY ? '✅ Connected' : '❌ Missing'}`);
    console.log('');
    console.log('⛓️ Active Chains:');
    console.log('  • Ethereum Mainnet 🟦');
    console.log('  • Base L2 🔵');
    console.log('');
    console.log('🌐 Ready for requests!');
    console.log('═══════════════════════════════════════════');
});

// Keep alive and error handling
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

process.on('SIGTERM', () => {
    console.log('👋 Shutting down gracefully...');
    server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled Rejection:', err);
});
