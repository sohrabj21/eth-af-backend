// server.js - Simplified backend for eth.af
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize cache (TTL: 5 minutes)
const cache = new NodeCache({ stdTTL: 300 });

// Trust proxy for Railway
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Ethereum provider for ENS
const provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/demo');

// ============================================
// Helper Functions
// ============================================

// Resolve ENS name to address
async function resolveENS(ensName) {
    try {
        const address = await provider.resolveName(ensName);
        return address;
    } catch (error) {
        console.error('ENS resolution error:', error);
        return null;
    }
}

// Validate Ethereum address
function isValidAddress(address) {
    return ethers.isAddress(address);
}

// Cache wrapper function
async function getCachedData(key, fetchFunction) {
    const cached = cache.get(key);
    if (cached) {
        console.log(`Cache hit for ${key}`);
        return cached;
    }
    
    console.log(`Cache miss for ${key}, fetching...`);
    const data = await fetchFunction();
    cache.set(key, data);
    return data;
}

// ============================================
// API Routes
// ============================================

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString()
    });
});

// Main wallet endpoint
app.get('/api/wallet/:addressOrEns', async (req, res) => {
    try {
        let address = req.params.addressOrEns;
        console.log(`Fetching wallet data for: ${address}`);
        
        // Resolve ENS if needed
        if (address.endsWith('.eth')) {
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
        const [tokens, nfts, prices] = await Promise.all([
            getTokenBalances(address),
            getNFTs(address),
            getTokenPrices()
        ]);
        
        // Calculate total value
        let totalValue = 0;
        const tokensWithUSD = tokens.map(token => {
            const price = prices[token.symbol] || 0;
            const usdValue = parseFloat(token.balance) * price;
            totalValue += usdValue;
            return {
                ...token,
                price,
                usdValue
            };
        });
        
        res.json({
            address,
            totalValue,
            tokens: tokensWithUSD,
            nfts,
            tokenCount: tokens.length,
            nftCount: nfts.reduce((sum, collection) => sum + collection.nfts.length, 0)
        });
        
    } catch (error) {
        console.error('Wallet endpoint error:', error);
        res.status(500).json({ error: 'Failed to fetch wallet data' });
    }
});

// Get token balances from Etherscan (simplified)
async function getTokenBalances(address) {
    const cacheKey = `tokens_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            console.log('Fetching ETH balance from Etherscan...');
            // Get ETH balance
            const ethBalanceUrl = `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${process.env.ETHERSCAN_API_KEY}`;
            const ethResponse = await axios.get(ethBalanceUrl);
            const ethBalance = ethers.formatEther(ethResponse.data.result || '0');
            
            return [
                {
                    name: 'Ethereum',
                    symbol: 'ETH',
                    balance: ethBalance,
                    decimals: 18
                }
            ];
            
        } catch (error) {
            console.error('Etherscan API error:', error.message);
            return [{
                name: 'Ethereum',
                symbol: 'ETH',
                balance: '0',
                decimals: 18
            }];
        }
    });
}

// Get NFTs using Alchemy
async function getNFTs(address) {
    const cacheKey = `nfts_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            console.log('Fetching NFTs from Alchemy...');
            const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner`;
            const response = await axios.get(url, {
                params: {
                    owner: address,
                    withMetadata: true,
                    pageSize: 100
                }
            });
            
            // Group NFTs by collection
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
            console.error('NFT API error:', error.message);
            return [];
        }
    });
}

// Get token prices
async function getTokenPrices() {
    const cacheKey = 'token_prices';
    
    return getCachedData(cacheKey, async () => {
        try {
            console.log('Fetching prices from CoinGecko...');
            const url = `https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd`;
            const response = await axios.get(url);
            
            return {
                'ETH': response.data.ethereum?.usd || 2000
            };
            
        } catch (error) {
            console.error('Price API error:', error.message);
            // Fallback price
            return {
                'ETH': 2000
            };
        }
    });
}

// Start server
app.listen(PORT, () => {
    console.log(`eth.af backend server running on port ${PORT}`);
    console.log('Environment check:');
    console.log('- Etherscan API:', process.env.ETHERSCAN_API_KEY ? '✓' : '✗');
    console.log('- Alchemy API:', process.env.ALCHEMY_API_KEY ? '✓' : '✗');
    console.log('Server is ready to handle requests!');
});

// Handle shutdown
process.on('SIGTERM', () => {
    console.log('Server shutting down...');
    process.exit(0);
});
