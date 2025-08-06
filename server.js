// server.js - Main backend server for eth.af
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize cache (TTL: 5 minutes)
const cache = new NodeCache({ stdTTL: 300 });

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    message: 'Too many requests, please try again later.'
});

app.use('/api/', limiter);

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

// Main wallet endpoint
app.get('/api/wallet/:addressOrEns', async (req, res) => {
    try {
        let address = req.params.addressOrEns;
        
        // Resolve ENS if needed
        if (address.endsWith('.eth')) {
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

// Get token balances from Etherscan
async function getTokenBalances(address) {
    const cacheKey = `tokens_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            // Get ETH balance
            const ethBalanceUrl = `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${process.env.ETHERSCAN_API_KEY}`;
            const ethResponse = await axios.get(ethBalanceUrl);
            const ethBalance = ethers.formatEther(ethResponse.data.result);
            
            // Get ERC-20 token balances
            const tokenBalanceUrl = `https://api.etherscan.io/api?module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&sort=asc&apikey=${process.env.ETHERSCAN_API_KEY}`;
            const tokenResponse = await axios.get(tokenBalanceUrl);
            
            // Process token transactions to get current balances
            const tokenBalances = {};
            if (tokenResponse.data.result) {
                tokenResponse.data.result.forEach(tx => {
                    const symbol = tx.tokenSymbol;
                    const name = tx.tokenName;
                    const decimals = parseInt(tx.tokenDecimal);
                    const value = parseFloat(ethers.formatUnits(tx.value, decimals));
                    
                    if (!tokenBalances[symbol]) {
                        tokenBalances[symbol] = {
                            name,
                            symbol,
                            balance: 0,
                            decimals,
                            contractAddress: tx.contractAddress
                        };
                    }
                    
                    if (tx.to.toLowerCase() === address.toLowerCase()) {
                        tokenBalances[symbol].balance += value;
                    } else {
                        tokenBalances[symbol].balance -= value;
                    }
                });
            }
            
            // Combine ETH and tokens
            const allTokens = [
                {
                    name: 'Ethereum',
                    symbol: 'ETH',
                    balance: ethBalance,
                    decimals: 18
                },
                ...Object.values(tokenBalances).filter(t => t.balance > 0.0001)
            ];
            
            return allTokens;
            
        } catch (error) {
            console.error('Etherscan API error:', error);
            return [];
        }
    });
}

// Get NFTs from OpenSea
async function getNFTs(address) {
    const cacheKey = `nfts_${address}`;
    
    return getCachedData(cacheKey, async () => {
        try {
            // OpenSea API v2 requires API key
            const headers = {
                'X-API-KEY': process.env.OPENSEA_API_KEY,
                'Accept': 'application/json'
            };
            
            // Get NFTs owned by address
            const url = `https://api.opensea.io/api/v2/chain/ethereum/account/${address}/nfts`;
            const response = await axios.get(url, { headers });
            
            // Group NFTs by collection
            const collections = {};
            
            if (response.data.nfts) {
                response.data.nfts.forEach(nft => {
                    const collectionName = nft.collection || 'Unknown Collection';
                    
                    if (!collections[collectionName]) {
                        collections[collectionName] = {
                            name: collectionName,
                            nfts: []
                        };
                    }
                    
                    collections[collectionName].nfts.push({
                        name: nft.name || `#${nft.identifier}`,
                        tokenId: nft.identifier,
                        image: nft.image_url || nft.display_image_url,
                        description: nft.description
                    });
                });
            }
            
            return Object.values(collections);
            
        } catch (error) {
            console.error('OpenSea API error:', error);
            
            // Fallback to alternative NFT API or return empty
            return await getNFTsFromAlternativeSource(address);
        }
    });
}

// Alternative NFT source (e.g., Alchemy NFT API)
async function getNFTsFromAlternativeSource(address) {
    try {
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
        console.error('Alternative NFT API error:', error);
        return [];
    }
}

// Get token prices from CoinGecko
async function getTokenPrices() {
    const cacheKey = 'token_prices';
    
    return getCachedData(cacheKey, async () => {
        try {
            // Common token IDs for CoinGecko
            const tokenIds = {
                'ETH': 'ethereum',
                'USDC': 'usd-coin',
                'USDT': 'tether',
                'DAI': 'dai',
                'WBTC': 'wrapped-bitcoin',
                'LINK': 'chainlink',
                'UNI': 'uniswap',
                'AAVE': 'aave',
                'MATIC': 'matic-network',
                'CRV': 'curve-dao-token',
                'MKR': 'maker',
                'SNX': 'synthetix-network-token',
                'COMP': 'compound-governance-token',
                'YFI': 'yearn-finance'
            };
            
            const ids = Object.values(tokenIds).join(',');
            const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
            
            const response = await axios.get(url, {
                headers: {
                    'x-cg-demo-api-key': process.env.COINGECKO_API_KEY || ''
                }
            });
            
            // Map back to symbols
            const prices = {};
            for (const [symbol, id] of Object.entries(tokenIds)) {
                if (response.data[id]) {
                    prices[symbol] = response.data[id].usd;
                }
            }
            
            return prices;
            
        } catch (error) {
            console.error('CoinGecko API error:', error);
            
            // Fallback prices for demo
            return {
                'ETH': 2000,
                'USDC': 1,
                'USDT': 1,
                'DAI': 1,
                'WBTC': 45000,
                'LINK': 7.5,
                'UNI': 6.5
            };
        }
    });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        cache: cache.getStats()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`eth.af backend server running on port ${PORT}`);
    console.log('Environment check:');
    console.log('- Etherscan API:', process.env.ETHERSCAN_API_KEY ? '✓' : '✗');
    console.log('- OpenSea API:', process.env.OPENSEA_API_KEY ? '✓' : '✗');
    console.log('- Alchemy API:', process.env.ALCHEMY_API_KEY ? '✓' : '✗');
    console.log('- CoinGecko API:', process.env.COINGECKO_API_KEY ? '✓' : '✗');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    app.close(() => {
        console.log('Server closed');
    });
});
