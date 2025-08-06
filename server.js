// server.js - Enhanced backend with DEX price fetching for ALL tokens
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

// Initialize cache (TTL: 5 minutes for data, 1 minute for prices)
const cache = new NodeCache({ stdTTL: 300 });
const priceCache = new NodeCache({ stdTTL: 60 });

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

// Chain configurations
const chainConfigs = {
    ethereum: { 
        id: 1, 
        name: 'Ethereum', 
        displayName: 'Ethereum Mainnet',
        emoji: '🟦',
        color: '#627EEA',
        explorer: 'etherscan.io',
        explorerApi: 'https://api.etherscan.io/api',
        nativeCurrency: 'ETH',
        alchemyPrefix: 'eth-mainnet',
        coingeckoId: 'ethereum',
        oneInchId: 1
    },
    base: { 
        id: 8453, 
        name: 'Base', 
        displayName: 'Base L2',
        emoji: '🔵',
        color: '#0052FF',
        explorer: 'basescan.org',
        explorerApi: 'https://api.basescan.org/api', 
        nativeCurrency: 'ETH',
        alchemyPrefix: 'base-mainnet',
        coingeckoId: 'base',
        oneInchId: 8453
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

async function getCachedData(key, fetchFunction, ttl = 300) {
    const cached = cache.get(key);
    if (cached) {
        console.log(`Cache hit for ${key}`);
        return cached;
    }
    
    console.log(`Cache miss for ${key}, fetching...`);
    try {
        const data = await fetchFunction();
        if (data) cache.set(key, data, ttl);
        return data;
    } catch (error) {
        console.error(`Error fetching ${key}:`, error.message);
        return null;
    }
}

// ============================================
// DEX Price Fetching
// ============================================

// Get token prices from 1inch API (works for ANY token with liquidity)
async function getDexTokenPrice(tokenAddress, chainId = 1) {
    const cacheKey = `dex_price_${chainId}_${tokenAddress}`;
    const cached = priceCache.get(cacheKey);
    if (cached) return cached;
    
    try {
        // 1inch Price API - no API key needed!
        const url = `https://api.1inch.io/v5.0/${chainId}/quote`;
        
        // Get price by comparing to USDC (1M USDC as base)
        const usdcAddress = chainId === 1 
            ? '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' // USDC on Ethereum
            : '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // USDC on Base
        
        const decimals = 18; // Most tokens use 18 decimals
        const amount = ethers.parseUnits('1', decimals).toString();
        
        const response = await axios.get(url, {
            params: {
                fromTokenAddress: tokenAddress,
                toTokenAddress: usdcAddress,
                amount: amount
            },
            headers: {
                'Accept': 'application/json'
            },
            timeout: 5000
        });
        
        if (response.data && response.data.toTokenAmount) {
            // Convert to price per token
            const price = parseFloat(ethers.formatUnits(response.data.toTokenAmount, 6)); // USDC has 6 decimals
            priceCache.set(cacheKey, price);
            return price;
        }
    } catch (error) {
        // Token might not have liquidity on 1inch, try alternative
        console.log(`1inch price not found for ${tokenAddress}, trying alternatives...`);
    }
    
    // Try DexScreener as backup
    try {
        const dexScreenerUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
        const response = await axios.get(dexScreenerUrl, { timeout: 5000 });
        
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            // Get the price from the pair with most liquidity
            const bestPair = response.data.pairs.sort((a, b) => 
                (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
            )[0];
            
            if (bestPair && bestPair.priceUsd) {
                const price = parseFloat(bestPair.priceUsd);
                priceCache.set(cacheKey, price);
                return price;
            }
        }
    } catch (error) {
        console.log(`DexScreener price not found for ${tokenAddress}`);
    }
    
    return 0; // No price found
}

// Get prices for multiple tokens efficiently
async function getTokenPricesWithDex(tokens) {
    const prices = {};
    
    // First, get common token prices from CoinGecko
    const commonPrices = await getCommonTokenPrices();
    
    // Then, for each token, try to get price
    const pricePromises = tokens.map(async (token) => {
        const symbol = token.symbol?.toUpperCase();
        
        // Check if we have a common price first
        if (commonPrices[symbol]) {
            prices[symbol] = commonPrices[symbol];
            return;
        }
        
        // If we have a contract address, get DEX price
        if (token.contractAddress && !token.isNative) {
            const chainId = token.chain === 'base' ? 8453 : 1;
            const dexPrice = await getDexTokenPrice(token.contractAddress, chainId);
            if (dexPrice > 0) {
                prices[symbol] = dexPrice;
                console.log(`✅ Found DEX price for ${symbol}: $${dexPrice}`);
            }
        }
    });
    
    await Promise.all(pricePromises);
    
    // Add native token prices
    prices['ETH'] = commonPrices['ETH'] || 2000;
    
    return prices;
}

// ============================================
// API Routes
// ============================================

// Root route
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'online',
        message: '🚀 eth.af API v5.0 with DEX pricing!',
        features: [
            '💎 ALL token prices via DEX',
            '🌐 Ethereum + Base L2',
            '📈 Real-time DEX prices',
            '🖼️ NFT floor prices',
            '📊 Transaction activity'
        ]
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString()
    });
});

// Main wallet endpoint with DEX pricing
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
        const [ethereumTokens, baseTokens, nfts, activity] = await Promise.all([
            getAllTokensForChain(address, 'ethereum'),
            getAllTokensForChain(address, 'base'),
            getEnhancedNFTsWithFloorPrices(address),
            getRecentActivity(address)
        ]);
        
        // Combine all tokens for price fetching
        const allTokensRaw = [...ethereumTokens, ...baseTokens];
        
        console.log(`💰 Fetching prices for ${allTokensRaw.length} tokens...`);
        
        // Get prices for ALL tokens using DEX data
        const prices = await getTokenPricesWithDex(allTokensRaw);
        
        // Process tokens with accurate pricing
        const allTokens = [];
        let totalValue = 0;
        
        // Process all tokens with their prices
        allTokensRaw.forEach(token => {
            const symbol = token.symbol?.toUpperCase();
            const price = prices[symbol] || 0;
            const balance = parseFloat(token.balance || 0);
            const usdValue = balance * price;
            
            // Include token if it has balance (even if price is 0)
            if (balance > 0.000001) {
                totalValue += usdValue;
                
                const chainEmoji = token.chain === 'base' ? '🔵' : '🟦';
                const chainColor = token.chain === 'base' ? '#0052FF' : '#627EEA';
                
                allTokens.push({
                    ...token,
                    chainEmoji,
                    chainColor,
                    price,
                    usdValue,
                    displayBalance: formatTokenBalance(balance, symbol),
                    hasPrice: price > 0
                });
            }
        });
        
        // Sort by USD value (tokens with value first, then by balance)
        allTokens.sort((a, b) => {
            if (a.usdValue > 0 && b.usdValue === 0) return -1;
            if (a.usdValue === 0 && b.usdValue > 0) return 1;
            if (a.usdValue !== b.usdValue) return b.usdValue - a.usdValue;
            return parseFloat(b.balance) - parseFloat(a.balance);
        });
        
        console.log(`✅ Wallet data ready: ${allTokens.length} tokens, $${totalValue.toFixed(2)} total`);
        
        res.status(200).json({
            address,
            ensName,
            totalValue,
            tokens: allTokens,
            tokensByChain: {
                ethereum: allTokens.filter(t => t.chain === 'ethereum'),
                base: allTokens.filter(t => t.chain === 'base')
            },
            nfts: nfts || [],
            activity: activity || [],
            tokenCount: allTokens.length,
            nftCount: (nfts || []).reduce((sum, collection) => sum + collection.nfts.length, 0),
            chainsWithBalance: [...new Set(allTokens.map(t => t.chain))],
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
            
            // Get native ETH balance for this specific chain
            console.log(`💰 Getting ETH balance on ${chain}...`);
            const ethBalance = await provider.getBalance(address);
            const formattedEthBalance = ethers.formatEther(ethBalance);
            
            // Only add ETH if there's a balance
            if (parseFloat(formattedEthBalance) > 0) {
                tokens.push({
                    name: chain === 'base' ? 'Ethereum on Base' : 'Ethereum',
                    symbol: 'ETH',
                    balance: formattedEthBalance,
                    decimals: 18,
                    logo: 'https://cryptologos.cc/logos/ethereum-eth-logo.png',
                    isNative: true,
                    chain: chain,
                    contractAddress: null
                });
            }
            
            // Get ALL ERC-20 tokens
            const alchemyUrl = `https://${config.alchemyPrefix}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
            
            console.log(`🔍 Fetching all ERC-20 tokens on ${chain}...`);
            
            const response = await axios.post(alchemyUrl, {
                jsonrpc: '2.0',
                method: 'alchemy_getTokenBalances',
                params: [address, 'erc20'],
                id: 1
            });
            
            if (response.data.result && response.data.result.tokenBalances) {
                // Filter tokens with non-zero balance
                const tokenBalances = response.data.result.tokenBalances.filter(tb => {
                    const balance = parseInt(tb.tokenBalance, 16);
                    return balance > 0;
                });
                
                console.log(`📊 Found ${tokenBalances.length} tokens with balance on ${chain}`);
                
                // Fetch metadata for each token
                const metadataPromises = tokenBalances.map(async (tokenBalance) => {
                    try {
                        const metadataResponse = await axios.post(alchemyUrl, {
                            jsonrpc: '2.0',
                            method: 'alchemy_getTokenMetadata',
                            params: [tokenBalance.contractAddress],
                            id: 1
                        });
                        
                        const metadata = metadataResponse.data.result;
                        if (!metadata || !metadata.symbol) return null;
                        
                        const balance = parseInt(tokenBalance.tokenBalance, 16);
                        const decimals = metadata.decimals || 18;
                        const formattedBalance = ethers.formatUnits(balance, decimals);
                        
                        // Include even tiny amounts - we'll filter later
                        return {
                            name: metadata.name || 'Unknown Token',
                            symbol: metadata.symbol || 'UNKNOWN',
                            balance: formattedBalance,
                            decimals: decimals,
                            logo: metadata.logo || '',
                            contractAddress: tokenBalance.contractAddress,
                            isNative: false,
                            chain: chain
                        };
                    } catch (error) {
                        console.error(`⚠️ Metadata error for ${tokenBalance.contractAddress}`);
                        return null;
                    }
                });
                
                const tokenResults = await Promise.all(metadataPromises);
                tokens.push(...tokenResults.filter(t => t !== null));
            }
            
            console.log(`✅ Total tokens found on ${chain}: ${tokens.length}`);
            return tokens;
            
        } catch (error) {
            console.error(`❌ Error fetching ${chain} tokens:`, error.message);
            return [];
        }
    }, 300); // Cache for 5 minutes
}

// Get common token prices from CoinGecko
async function getCommonTokenPrices() {
    const cacheKey = 'common_token_prices';
    
    return getCachedData(cacheKey, async () => {
        try {
            const tokenList = [
                'ethereum', 'wrapped-bitcoin', 'tether', 'usd-coin', 'dai',
                'chainlink', 'uniswap', 'aave', 'curve-dao-token', 'maker',
                'compound-governance-token', 'sushi', 'the-graph', '1inch',
                'matic-network', 'arbitrum', 'optimism', 'lido-dao',
                'rocket-pool', 'frax-share', 'convex-finance', 'yearn-finance',
                'balancer', 'ape-coin', 'the-sandbox', 'decentraland',
                'axie-infinity', 'immutable-x', 'gala', 'enjincoin',
                'render-token', 'blur', 'shiba-inu', 'pepe', 'floki'
            ];
            
            const url = 'https://api.coingecko.com/api/v3/simple/price';
            const response = await axios.get(url, {
                params: {
                    ids: tokenList.join(','),
                    vs_currencies: 'usd'
                },
                timeout: 5000
            });
            
            // Map to symbols
            const priceMap = {
                'ETH': response.data.ethereum?.usd || 2000,
                'WETH': response.data.ethereum?.usd || 2000,
                'WBTC': response.data['wrapped-bitcoin']?.usd || 45000,
                'USDT': response.data.tether?.usd || 1,
                'USDC': response.data['usd-coin']?.usd || 1,
                'DAI': response.data.dai?.usd || 1,
                'LINK': response.data.chainlink?.usd || 10,
                'UNI': response.data.uniswap?.usd || 5,
                'AAVE': response.data.aave?.usd || 50,
                'CRV': response.data['curve-dao-token']?.usd || 1,
                'MKR': response.data.maker?.usd || 1000,
                'COMP': response.data['compound-governance-token']?.usd || 50,
                'SUSHI': response.data.sushi?.usd || 1,
                'GRT': response.data['the-graph']?.usd || 0.1,
                '1INCH': response.data['1inch']?.usd || 0.5,
                'MATIC': response.data['matic-network']?.usd || 0.8,
                'ARB': response.data.arbitrum?.usd || 1,
                'OP': response.data.optimism?.usd || 1.5,
                'LDO': response.data['lido-dao']?.usd || 2,
                'RPL': response.data['rocket-pool']?.usd || 20,
                'FXS': response.data['frax-share']?.usd || 5,
                'CVX': response.data['convex-finance']?.usd || 3,
                'YFI': response.data['yearn-finance']?.usd || 5000,
                'BAL': response.data.balancer?.usd || 5,
                'APE': response.data['ape-coin']?.usd || 1,
                'SAND': response.data['the-sandbox']?.usd || 0.5,
                'MANA': response.data.decentraland?.usd || 0.5,
                'AXS': response.data['axie-infinity']?.usd || 5,
                'IMX': response.data['immutable-x']?.usd || 0.5,
                'GALA': response.data.gala?.usd || 0.02,
                'ENJ': response.data.enjincoin?.usd || 0.3,
                'RNDR': response.data['render-token']?.usd || 2,
                'BLUR': response.data.blur?.usd || 0.3,
                'SHIB': response.data['shiba-inu']?.usd || 0.000008,
                'PEPE': response.data.pepe?.usd || 0.0000001,
                'FLOKI': response.data.floki?.usd || 0.00003
            };
            
            return priceMap;
            
        } catch (error) {
            console.error('CoinGecko error:', error);
            return { 'ETH': 2000, 'USDC': 1, 'USDT': 1, 'DAI': 1 };
        }
    }, 60); // Cache for 1 minute
}

// Get recent activity
async function getRecentActivity(address) {
    const cacheKey = `activity_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            console.log('📊 Fetching recent activity...');
            
            // Fetch from Etherscan
            if (!process.env.ETHERSCAN_API_KEY) {
                return [];
            }
            
            const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=20&sort=desc&apikey=${process.env.ETHERSCAN_API_KEY}`;
            
            const response = await axios.get(url, { timeout: 5000 });
            
            if (response.data.status === '1' && response.data.result) {
                const transactions = response.data.result.slice(0, 10);
                
                return transactions.map(tx => ({
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to,
                    value: ethers.formatEther(tx.value || '0'),
                    timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
                    method: tx.functionName?.split('(')[0] || 'Transfer',
                    status: tx.txreceipt_status === '1' ? 'success' : 'failed',
                    gas: tx.gasUsed,
                    chain: 'ethereum'
                }));
            }
            
            return [];
            
        } catch (error) {
            console.error('Activity error:', error);
            return [];
        }
    }, 60); // Cache for 1 minute
}

// Enhanced NFT fetching with floor prices
async function getEnhancedNFTsWithFloorPrices(address) {
    const cacheKey = `nfts_with_floor_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            console.log('🎨 Fetching NFT collections...');
            
            const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner`;
            
            const response = await axios.get(url, {
                params: {
                    owner: address,
                    withMetadata: true,
                    pageSize: 100
                },
                timeout: 10000
            });
            
            const collections = {};
            
            if (response.data.ownedNfts) {
                response.data.ownedNfts.forEach(nft => {
                    const collectionName = nft.contract.name || 'Unknown Collection';
                    const collectionKey = `${collectionName}_${nft.contract.address}`;
                    
                    if (!collections[collectionKey]) {
                        collections[collectionKey] = {
                            name: collectionName,
                            symbol: nft.contract.symbol || '',
                            address: nft.contract.address,
                            nfts: [],
                            floorPrice: 0,
                            chain: 'ethereum'
                        };
                    }
                    
                    let imageUrl = nft.image?.cachedUrl || 
                                  nft.image?.thumbnailUrl || 
                                  nft.image?.pngUrl ||
                                  nft.image?.originalUrl ||
                                  nft.media?.[0]?.gateway ||
                                  '';
                    
                    if (imageUrl && imageUrl.startsWith('ipfs://')) {
                        imageUrl = `https://ipfs.io/ipfs/${imageUrl.slice(7)}`;
                    }
                    
                    collections[collectionKey].nfts.push({
                        name: nft.name || nft.title || `${nft.contract.symbol} #${nft.tokenId}`,
                        tokenId: nft.tokenId,
                        image: imageUrl,
                        hasImage: !!imageUrl
                    });
                });
            }
            
            // Sort NFTs within collections
            Object.values(collections).forEach(collection => {
                collection.nfts.sort((a, b) => {
                    if (a.hasImage && !b.hasImage) return -1;
                    if (!a.hasImage && b.hasImage) return 1;
                    return 0;
                });
            });
            
            // Get floor prices from Alchemy
            const collectionsArray = Object.values(collections);
            
            for (const collection of collectionsArray) {
                try {
                    const floorResponse = await axios.post(
                        `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getFloorPrice`,
                        { contractAddress: collection.address },
                        { timeout: 5000 }
                    );
                    
                    if (floorResponse.data && floorResponse.data.openSea?.floorPrice) {
                        collection.floorPrice = floorResponse.data.openSea.floorPrice;
                    }
                } catch (error) {
                    // Floor price not available
                }
            }
            
            // Sort by floor price
            collectionsArray.sort((a, b) => (b.floorPrice || 0) - (a.floorPrice || 0));
            
            return collectionsArray;
            
        } catch (error) {
            console.error('NFT error:', error);
            return [];
        }
    }, 300); // Cache for 5 minutes
}

// Format token balance
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
        message: '🔍 Endpoint not found'
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     🚀 eth.af Backend v5.0              ║');
    console.log('║         with DEX Price Fetching         ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`📡 Port: ${PORT}`);
    console.log('✨ Features:');
    console.log('  • ALL token prices via DEX APIs');
    console.log('  • 1inch + DexScreener integration');
    console.log('  • Ethereum + Base L2 support');
    console.log('  • NFT floor prices');
    console.log('  • Transaction activity');
    console.log('🔑 APIs:');
    console.log(`  • Etherscan: ${process.env.ETHERSCAN_API_KEY ? '✅' : '❌'}`);
    console.log(`  • Alchemy: ${process.env.ALCHEMY_API_KEY ? '✅' : '❌'}`);
    console.log('  • 1inch: ✅ (no key needed)');
    console.log('  • DexScreener: ✅ (no key needed)');
    console.log('═══════════════════════════════════════════');
});

// Error handling
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});
