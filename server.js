// server.js - Railway-optimized backend for eth.af
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
// Railway requires this exact setup
const PORT = parseInt(process.env.PORT) || 3000;

// Initialize cache (TTL: 5 minutes)
const cache = new NodeCache({ stdTTL: 300 });

// CRITICAL: Railway configuration
app.set('trust proxy', true);
app.enable('trust proxy');

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Ethereum provider
const provider = new ethers.JsonRpcProvider(
    process.env.ETHEREUM_RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/demo'
);

// ============================================
// Helper Functions
// ============================================

async function resolveENS(ensName) {
    try {
        const address = await provider.resolveName(ensName);
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
// ROUTES - Root MUST be first for Railway
// ============================================

// Root route - Railway health check
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'online',
        message: 'eth.af API is running!',
        endpoints: {
            health: '/api/health',
            wallet: '/api/wallet/{address-or-ens}',
            example: '/api/wallet/vitalik.eth'
        }
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        port: PORT,
        environment: process.env.NODE_ENV || 'production'
    });
});

// Main wallet endpoint
app.get('/api/wallet/:addressOrEns', async (req, res) => {
    try {
        let address = req.params.addressOrEns;
        console.log(`[${new Date().toISOString()}] Fetching wallet: ${address}`);
        
        // Resolve ENS if needed
        if (address.toLowerCase().endsWith('.eth')) {
            console.log('Resolving ENS name...');
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
        
        // Fetch all data
        const [tokens, nfts, prices] = await Promise.all([
            getTokenBalances(address),
            getNFTs(address),
            getTokenPrices()
        ]);
        
        // Calculate total value
        let totalValue = 0;
        const tokensWithUSD = (tokens || []).map(token => {
            const price = prices[token.symbol] || 0;
            const usdValue = parseFloat(token.balance || 0) * price;
            totalValue += usdValue;
            return {
                ...token,
                price,
                usdValue
            };
        });
        
        res.status(200).json({
            address,
            totalValue,
            tokens: tokensWithUSD,
            nfts: nfts || [],
            tokenCount: tokensWithUSD.length,
            nftCount: (nfts || []).reduce((sum, collection) => sum + collection.nfts.length, 0)
        });
        
    } catch (error) {
        console.error('Wallet endpoint error:', error);
        res.status(500).json({ error: 'Failed to fetch wallet data', details: error.message });
    }
});

// Get token balances
async function getTokenBalances(address) {
    const cacheKey = `tokens_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            if (!process.env.ETHERSCAN_API_KEY) {
                console.warn('No Etherscan API key found');
                return [];
            }
            
            console.log('Fetching ETH balance...');
            const url = `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${process.env.ETHERSCAN_API_KEY}`;
            const response = await axios.get(url, { timeout: 10000 });
            
            if (response.data.status === '1' && response.data.result) {
                const ethBalance = ethers.formatEther(response.data.result);
                return [{
                    name: 'Ethereum',
                    symbol: 'ETH',
                    balance: ethBalance,
                    decimals: 18
                }];
            }
            
            return [];
        } catch (error) {
            console.error('Etherscan error:', error.message);
            return [];
        }
    });
}

// Get NFTs
async function getNFTs(address) {
    const cacheKey = `nfts_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            if (!process.env.ALCHEMY_API_KEY) {
                console.warn('No Alchemy API key found');
                return [];
            }
            
            console.log('Fetching NFTs...');
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
                    
                    if (!collections[collectionName]) {
                        collections[collectionName] = {
                            name: collectionName,
                            nfts: []
                        };
                    }
                    
                    collections[collectionName].nfts.push({
                        name: nft.name || nft.title || `#${nft.tokenId}`,
                        tokenId: nft.tokenId,
                        image: nft.image?.thumbnail || nft.media?.[0]?.thumbnail,
                        description: nft.description
                    });
                });
            }
            
            return Object.values(collections);
        } catch (error) {
            console.error('NFT fetch error:', error.message);
            return [];
        }
    });
}

// Get token prices
async function getTokenPrices() {
    const cacheKey = 'token_prices';
    
    return getCachedData(cacheKey, async () => {
        try {
            console.log('Fetching ETH price...');
            const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
            const response = await axios.get(url, { timeout: 5000 });
            
            return {
                'ETH': response.data.ethereum?.usd || 2000
            };
        } catch (error) {
            console.error('Price fetch error:', error.message);
            return { 'ETH': 2000 }; // Fallback price
        }
    });
}

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Not Found', 
        message: `Cannot ${req.method} ${req.url}`,
        availableEndpoints: {
            root: '/',
            health: '/api/health',
            wallet: '/api/wallet/{address-or-ens}'
        }
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal Server Error',
        message: err.message 
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log(`eth.af backend server started`);
    console.log(`Port: ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
    console.log('========================================');
    console.log('API Keys Status:');
    console.log(`- Etherscan: ${process.env.ETHERSCAN_API_KEY ? '✓ Configured' : '✗ Missing'}`);
    console.log(`- Alchemy: ${process.env.ALCHEMY_API_KEY ? '✓ Configured' : '✗ Missing'}`);
    console.log(`- RPC URL: ${process.env.ETHEREUM_RPC_URL?.includes('demo') ? '⚠️ Using demo' : '✓ Configured'}`);
    console.log('========================================');
    console.log('Server is ready for requests!');
    console.log('Test URL: http://0.0.0.0:' + PORT);
    console.log('========================================');
});

// Keep alive
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Prevent crashes
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});
