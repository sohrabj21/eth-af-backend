// server.js - Enhanced backend with full token and NFT support
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

// Initialize providers for multiple chains
const providers = {
    ethereum: new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL || `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`),
    arbitrum: new ethers.JsonRpcProvider(`https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`),
    optimism: new ethers.JsonRpcProvider(`https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`),
    polygon: new ethers.JsonRpcProvider(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`),
    base: new ethers.JsonRpcProvider(`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`)
};

// Chain configurations
const chainConfigs = {
    ethereum: { id: 1, name: 'Ethereum', explorer: 'etherscan.io', nativeCurrency: 'ETH' },
    arbitrum: { id: 42161, name: 'Arbitrum', explorer: 'arbiscan.io', nativeCurrency: 'ETH' },
    optimism: { id: 10, name: 'Optimism', explorer: 'optimistic.etherscan.io', nativeCurrency: 'ETH' },
    polygon: { id: 137, name: 'Polygon', explorer: 'polygonscan.com', nativeCurrency: 'MATIC' },
    base: { id: 8453, name: 'Base', explorer: 'basescan.org', nativeCurrency: 'ETH' }
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
        cache.set(key, data);
        return data;
    } catch (error) {
        console.error(`Error fetching ${key}:`, error.message);
        return null;
    }
}

// ============================================
// API Routes
// ============================================

// Root route
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'online',
        message: 'eth.af API is running!',
        version: '2.0',
        features: ['multi-chain', 'all-tokens', 'nft-images'],
        supportedChains: Object.keys(chainConfigs),
        endpoints: {
            health: '/api/health',
            wallet: '/api/wallet/{address-or-ens}',
            walletMultichain: '/api/wallet-multichain/{address-or-ens}'
        }
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        port: PORT
    });
});

// Enhanced wallet endpoint with full token support
app.get('/api/wallet/:addressOrEns', async (req, res) => {
    try {
        let address = req.params.addressOrEns;
        console.log(`[${new Date().toISOString()}] Fetching wallet: ${address}`);
        
        // Resolve ENS if needed
        if (address.toLowerCase().endsWith('.eth')) {
            const resolved = await resolveENS(address);
            if (!resolved) {
                return res.status(400).json({ error: 'Invalid ENS name' });
            }
            address = resolved;
            console.log(`ENS resolved to: ${address}`);
        }
        
        // Validate address
        if (!isValidAddress(address)) {
            return res.status(400).json({ error: 'Invalid Ethereum address' });
        }
        
        // Fetch all data in parallel
        const [allTokens, nfts, prices] = await Promise.all([
            getAllTokenBalances(address),
            getEnhancedNFTs(address),
            getComprehensiveTokenPrices()
        ]);
        
        // Calculate total value and add USD prices
        let totalValue = 0;
        const tokensWithUSD = allTokens.map(token => {
            const price = prices[token.symbol] || prices[token.symbol?.toLowerCase()] || 0;
            const usdValue = parseFloat(token.balance || 0) * price;
            totalValue += usdValue;
            return {
                ...token,
                price,
                usdValue,
                displayBalance: formatTokenBalance(token.balance, token.symbol)
            };
        }).filter(token => token.balance > 0.00001); // Filter dust
        
        res.status(200).json({
            address,
            totalValue,
            tokens: tokensWithUSD,
            nfts: nfts || [],
            tokenCount: tokensWithUSD.length,
            nftCount: (nfts || []).reduce((sum, collection) => sum + collection.nfts.length, 0),
            chains: ['ethereum'] // For now, just Ethereum
        });
        
    } catch (error) {
        console.error('Wallet endpoint error:', error);
        res.status(500).json({ error: 'Failed to fetch wallet data', details: error.message });
    }
});

// Multi-chain wallet endpoint
app.get('/api/wallet-multichain/:addressOrEns', async (req, res) => {
    try {
        let address = req.params.addressOrEns;
        
        // Resolve ENS if needed
        if (address.toLowerCase().endsWith('.eth')) {
            const resolved = await resolveENS(address);
            if (!resolved) {
                return res.status(400).json({ error: 'Invalid ENS name' });
            }
            address = resolved;
        }
        
        // Validate address
        if (!isValidAddress(address)) {
            return res.status(400).json({ error: 'Invalid Ethereum address' });
        }
        
        // Fetch data from all chains in parallel
        const chainPromises = Object.keys(chainConfigs).map(async (chain) => {
            try {
                const tokens = await getTokensForChain(address, chain);
                return { chain, tokens };
            } catch (error) {
                console.error(`Error fetching ${chain}:`, error.message);
                return { chain, tokens: [] };
            }
        });
        
        const chainResults = await Promise.all(chainPromises);
        const prices = await getComprehensiveTokenPrices();
        
        // Process results
        let totalValue = 0;
        const tokensByChain = {};
        
        chainResults.forEach(({ chain, tokens }) => {
            const tokensWithUSD = tokens.map(token => {
                const price = prices[token.symbol] || prices[token.symbol?.toLowerCase()] || 0;
                const usdValue = parseFloat(token.balance || 0) * price;
                totalValue += usdValue;
                return {
                    ...token,
                    chain,
                    price,
                    usdValue
                };
            }).filter(token => token.balance > 0.00001);
            
            if (tokensWithUSD.length > 0) {
                tokensByChain[chain] = tokensWithUSD;
            }
        });
        
        // Get NFTs
        const nfts = await getEnhancedNFTs(address);
        
        res.status(200).json({
            address,
            totalValue,
            tokensByChain,
            nfts,
            totalTokens: Object.values(tokensByChain).flat().length,
            totalNFTs: (nfts || []).reduce((sum, collection) => sum + collection.nfts.length, 0),
            chainsWithBalance: Object.keys(tokensByChain)
        });
        
    } catch (error) {
        console.error('Multi-chain endpoint error:', error);
        res.status(500).json({ error: 'Failed to fetch multi-chain data' });
    }
});

// Get ALL token balances including ERC-20s
async function getAllTokenBalances(address) {
    const cacheKey = `all_tokens_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            const tokens = [];
            
            // Get ETH balance
            const ethBalance = await providers.ethereum.getBalance(address);
            tokens.push({
                name: 'Ethereum',
                symbol: 'ETH',
                balance: ethers.formatEther(ethBalance),
                decimals: 18,
                logo: 'https://cryptologos.cc/logos/ethereum-eth-logo.png',
                isNative: true
            });
            
            // Get all ERC-20 tokens using Alchemy Token API
            if (process.env.ALCHEMY_API_KEY) {
                const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
                
                // Get token balances
                const response = await axios.post(alchemyUrl, {
                    jsonrpc: '2.0',
                    method: 'alchemy_getTokenBalances',
                    params: [address],
                    id: 1
                });
                
                if (response.data.result && response.data.result.tokenBalances) {
                    // Get metadata for tokens with balance
                    const tokenBalances = response.data.result.tokenBalances.filter(
                        tb => tb.tokenBalance !== '0x0'
                    );
                    
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
                            const balance = parseInt(tokenBalance.tokenBalance, 16);
                            const decimals = metadata.decimals || 18;
                            const formattedBalance = ethers.formatUnits(balance, decimals);
                            
                            tokens.push({
                                name: metadata.name || 'Unknown Token',
                                symbol: metadata.symbol || 'UNKNOWN',
                                balance: formattedBalance,
                                decimals: decimals,
                                logo: metadata.logo || `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${tokenBalance.contractAddress}/logo.png`,
                                contractAddress: tokenBalance.contractAddress,
                                isNative: false
                            });
                        } catch (error) {
                            console.error(`Error fetching metadata for ${tokenBalance.contractAddress}`);
                        }
                    }
                }
            }
            
            return tokens;
            
        } catch (error) {
            console.error('Token fetch error:', error.message);
            return [];
        }
    });
}

// Get tokens for a specific chain
async function getTokensForChain(address, chain) {
    if (chain === 'ethereum') {
        return getAllTokenBalances(address);
    }
    
    // For L2s and other chains
    try {
        const tokens = [];
        const provider = providers[chain];
        
        if (!provider) return [];
        
        // Get native token balance
        const balance = await provider.getBalance(address);
        const nativeCurrency = chainConfigs[chain].nativeCurrency;
        
        tokens.push({
            name: nativeCurrency === 'MATIC' ? 'Polygon' : 'Ethereum',
            symbol: nativeCurrency,
            balance: ethers.formatEther(balance),
            decimals: 18,
            isNative: true
        });
        
        // For other tokens, we'd need chain-specific APIs
        // This would require additional setup for each chain
        
        return tokens;
    } catch (error) {
        console.error(`Error fetching ${chain} tokens:`, error);
        return [];
    }
}

// Enhanced NFT fetching with proper images
async function getEnhancedNFTs(address) {
    const cacheKey = `enhanced_nfts_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            console.log('Fetching enhanced NFTs...');
            const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner`;
            
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
                    
                    if (!collections[collectionName]) {
                        collections[collectionName] = {
                            name: collectionName,
                            symbol: collectionSymbol,
                            address: nft.contract.address,
                            nfts: [],
                            floorPrice: null // Could fetch from OpenSea
                        };
                    }
                    
                    // Get the best available image
                    let imageUrl = nft.image?.cachedUrl || 
                                  nft.image?.thumbnailUrl || 
                                  nft.image?.pngUrl ||
                                  nft.image?.originalUrl ||
                                  nft.media?.[0]?.gateway ||
                                  nft.media?.[0]?.raw ||
                                  '';
                    
                    // Handle IPFS URLs
                    if (imageUrl.startsWith('ipfs://')) {
                        imageUrl = `https://ipfs.io/ipfs/${imageUrl.slice(7)}`;
                    }
                    
                    collections[collectionName].nfts.push({
                        name: nft.name || nft.title || `${collectionSymbol} #${nft.tokenId}`,
                        tokenId: nft.tokenId,
                        image: imageUrl,
                        description: nft.description,
                        attributes: nft.raw?.metadata?.attributes || [],
                        tokenType: nft.tokenType, // ERC721 or ERC1155
                        balance: nft.balance || 1
                    });
                });
            }
            
            return Object.values(collections);
            
        } catch (error) {
            console.error('Enhanced NFT fetch error:', error.message);
            return [];
        }
    });
}

// Get comprehensive token prices
async function getComprehensiveTokenPrices() {
    const cacheKey = 'comprehensive_prices';
    
    return getCachedData(cacheKey, async () => {
        try {
            // Fetch prices for top 100 tokens
            const url = 'https://api.coingecko.com/api/v3/simple/price';
            const response = await axios.get(url, {
                params: {
                    ids: 'ethereum,matic-network,chainlink,uniswap,aave,curve-dao-token,maker,compound-governance-token,synthetix-network-token,yearn-finance,the-graph,1inch,sushi,balancer,bancor,uma,republic-protocol,numeraire,keep-network,nest-protocol,wrapped-bitcoin,tether,usd-coin,dai,binance-usd,frax,true-usd,paxos-standard,huobi-token,crypto-com-chain,ftx-token,okb,leo-token,nexo,celsius-degree-token,thorchain,quant-network,telcoin,loopring,request-network,ocean-protocol,energy-web-token,singularitynet,fetch-ai,iexec-rlc,streamr,dent,power-ledger',
                    vs_currencies: 'usd'
                }
            });
            
            // Map to symbols
            const priceMap = {
                'ETH': response.data.ethereum?.usd || 2000,
                'MATIC': response.data['matic-network']?.usd || 1,
                'LINK': response.data.chainlink?.usd || 10,
                'UNI': response.data.uniswap?.usd || 5,
                'AAVE': response.data.aave?.usd || 50,
                'CRV': response.data['curve-dao-token']?.usd || 1,
                'MKR': response.data.maker?.usd || 1000,
                'COMP': response.data['compound-governance-token']?.usd || 50,
                'USDT': response.data.tether?.usd || 1,
                'USDC': response.data['usd-coin']?.usd || 1,
                'DAI': response.data.dai?.usd || 1,
                'WBTC': response.data['wrapped-bitcoin']?.usd || 30000,
                // Add more mappings as needed
            };
            
            return priceMap;
            
        } catch (error) {
            console.error('Price fetch error:', error.message);
            // Return fallback prices
            return {
                'ETH': 2000,
                'MATIC': 0.8,
                'USDC': 1,
                'USDT': 1,
                'DAI': 1,
                'WBTC': 45000
            };
        }
    });
}

// Format token balance for display
function formatTokenBalance(balance, symbol) {
    const bal = parseFloat(balance);
    if (bal === 0) return '0';
    if (bal < 0.00001) return '<0.00001';
    if (bal < 1) return bal.toFixed(6);
    if (bal < 1000) return bal.toFixed(4);
    if (bal < 1000000) return `${(bal / 1000).toFixed(2)}K`;
    return `${(bal / 1000000).toFixed(2)}M`;
}

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Not Found',
        availableEndpoints: {
            root: '/',
            health: '/api/health',
            wallet: '/api/wallet/{address}',
            multichain: '/api/wallet-multichain/{address}'
        }
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log(`eth.af Multi-Chain Backend v2.0`);
    console.log(`Port: ${PORT}`);
    console.log('========================================');
    console.log('Features:');
    console.log('✓ All ERC-20 tokens');
    console.log('✓ Multi-chain support');
    console.log('✓ Enhanced NFT images');
    console.log('✓ Comprehensive pricing');
    console.log('========================================');
    console.log('API Keys Status:');
    console.log(`- Etherscan: ${process.env.ETHERSCAN_API_KEY ? '✓' : '✗'}`);
    console.log(`- Alchemy: ${process.env.ALCHEMY_API_KEY ? '✓' : '✗'}`);
    console.log('========================================');
});

// Keep alive and error handling
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
