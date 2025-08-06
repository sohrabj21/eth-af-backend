// server.js - Robust backend with comprehensive token fetching
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

// ============================================
// PROVIDERS SETUP
// ============================================

const providers = {
    ethereum: new ethers.JsonRpcProvider(
        `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    )
};

// Only add Base provider if it's available
if (process.env.ALCHEMY_API_KEY) {
    providers.base = new ethers.JsonRpcProvider(
        `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    );
}

// ============================================
// MAIN WALLET ENDPOINT
// ============================================

app.get('/api/wallet/:addressOrEns', async (req, res) => {
    try {
        let address = req.params.addressOrEns;
        let ensName = null;
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔍 FETCHING WALLET: ${address}`);
        console.log(`${'='.repeat(60)}`);
        
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
        
        // Fetch Ethereum tokens (always works)
        const ethereumTokens = await fetchAllTokens(address, 'ethereum');
        
        // Try to fetch Base tokens (might fail if not enabled)
        let baseTokens = [];
        try {
            baseTokens = await fetchAllTokens(address, 'base');
        } catch (error) {
            console.log('⚠️ Base network not available or not enabled in Alchemy');
        }
        
        // Fetch NFTs and activity
        const [nfts, activity] = await Promise.all([
            fetchNFTsWithFloorPrices(address),
            fetchRecentActivity(address)
        ]);
        
        // Combine all tokens
        const allTokens = [...ethereumTokens, ...baseTokens];
        
        // Get prices for all tokens
        console.log('\n💰 Fetching token prices...');
        for (let token of allTokens) {
            if (token.contractAddress && !token.price) {
                token.price = await getTokenPrice(token);
                token.usdValue = parseFloat(token.balance) * token.price;
            }
        }
        
        // Calculate total value
        const totalValue = allTokens.reduce((sum, t) => sum + (t.usdValue || 0), 0);
        
        // Sort by USD value
        allTokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
        
        console.log(`\n✅ SUMMARY:`);
        console.log(`  • Total tokens: ${allTokens.length}`);
        console.log(`  • Ethereum tokens: ${ethereumTokens.length}`);
        console.log(`  • Base tokens: ${baseTokens.length}`);
        console.log(`  • Total value: $${totalValue.toFixed(2)}`);
        console.log(`  • NFT collections: ${nfts.length}`);
        
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
// COMPREHENSIVE TOKEN FETCHING
// ============================================

async function fetchAllTokens(address, chain) {
    console.log(`\n📊 Fetching ${chain} tokens for ${address.slice(0, 6)}...`);
    
    const tokens = [];
    
    try {
        // 1. Get native ETH balance
        const provider = providers[chain];
        if (!provider) {
            console.log(`  ⚠️ No provider for ${chain}`);
            return [];
        }
        
        const ethBalance = await provider.getBalance(address);
        const ethFormatted = ethers.formatEther(ethBalance);
        
        if (parseFloat(ethFormatted) > 0) {
            const ethPrice = await getETHPrice();
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
            console.log(`  ✓ ETH: ${parseFloat(ethFormatted).toFixed(4)} ETH`);
        }
        
        // 2. Get all ERC-20 tokens via Alchemy
        const alchemyUrl = `https://${chain === 'base' ? 'base' : 'eth'}-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
        
        // Get token balances
        const balancesRes = await axios.post(alchemyUrl, {
            jsonrpc: '2.0',
            method: 'alchemy_getTokenBalances',
            params: [address],
            id: 1
        });
        
        if (balancesRes.data.result?.tokenBalances) {
            const nonZeroBalances = balancesRes.data.result.tokenBalances.filter(
                tb => tb.tokenBalance && tb.tokenBalance !== '0x0' && tb.tokenBalance !== '0x'
            );
            
            console.log(`  📦 Found ${nonZeroBalances.length} tokens with balances`);
            
            // Get metadata for each token
            for (const tokenBalance of nonZeroBalances) {
                try {
                    const metadataRes = await axios.post(alchemyUrl, {
                        jsonrpc: '2.0',
                        method: 'alchemy_getTokenMetadata',
                        params: [tokenBalance.contractAddress],
                        id: 1
                    });
                    
                    const metadata = metadataRes.data.result;
                    if (!metadata) continue;
                    
                    const decimals = metadata.decimals || 18;
                    const rawBalance = tokenBalance.tokenBalance;
                    const formattedBalance = ethers.formatUnits(rawBalance, decimals);
                    
                    // Skip dust
                    if (parseFloat(formattedBalance) < 0.000000001) continue;
                    
                    tokens.push({
                        name: metadata.name || 'Unknown Token',
                        symbol: metadata.symbol || 'UNKNOWN',
                        balance: formattedBalance,
                        decimals: decimals,
                        contractAddress: tokenBalance.contractAddress,
                        chain,
                        chainEmoji: chain === 'base' ? '🔵' : '🟦',
                        logo: metadata.logo || '',
                        price: 0, // Will be fetched later
                        usdValue: 0
                    });
                    
                    console.log(`  ✓ ${metadata.symbol}: ${parseFloat(formattedBalance).toFixed(6)}`);
                    
                } catch (err) {
                    console.error(`  ⚠️ Error getting metadata for ${tokenBalance.contractAddress}`);
                }
            }
        }
        
    } catch (error) {
        console.error(`❌ Error fetching ${chain} tokens:`, error.message);
        if (error.response?.status === 403) {
            console.log(`  ⚠️ ${chain} network not enabled in Alchemy. Please enable it in your Alchemy dashboard.`);
        }
    }
    
    return tokens;
}

// ============================================
// TOKEN PRICE FETCHING
// ============================================

async function getETHPrice() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { ids: 'ethereum', vs_currencies: 'usd' }
        });
        return res.data.ethereum?.usd || 2000;
    } catch (err) {
        return 2000; // Fallback
    }
}

async function getTokenPrice(token) {
    // Check cache first
    const cacheKey = `price_${token.symbol}_${token.contractAddress}`;
    const cached = priceCache.get(cacheKey);
    if (cached) return cached;
    
    let price = 0;
    
    // Common tokens
    const commonPrices = {
        'USDC': 1, 'USDT': 1, 'DAI': 1, 'BUSD': 1, 'TUSD': 1,
        'WETH': await getETHPrice(),
        'WBTC': 45000
    };
    
    if (commonPrices[token.symbol]) {
        price = commonPrices[token.symbol];
    }
    
    // Try CoinGecko
    if (!price && token.symbol) {
        try {
            const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
                params: {
                    ids: token.name?.toLowerCase().replace(/\s+/g, '-'),
                    vs_currencies: 'usd'
                },
                timeout: 3000
            });
            
            const key = Object.keys(res.data)[0];
            if (key && res.data[key]?.usd) {
                price = res.data[key].usd;
            }
        } catch (err) {
            // Ignore CoinGecko errors
        }
    }
    
    // Try DexScreener for contract address
    if (!price && token.contractAddress) {
        try {
            const res = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${token.contractAddress}`,
                { timeout: 3000 }
            );
            
            if (res.data?.pairs?.[0]?.priceUsd) {
                price = parseFloat(res.data.pairs[0].priceUsd);
                console.log(`    💰 DexScreener price for ${token.symbol}: $${price}`);
            }
        } catch (err) {
            // Ignore DexScreener errors
        }
    }
    
    // Cache the price
    if (price > 0) {
        priceCache.set(cacheKey, price);
    }
    
    return price;
}

// ============================================
// NFT FETCHING WITH FLOOR PRICES
// ============================================

async function fetchNFTsWithFloorPrices(address) {
    try {
        console.log('\n🎨 Fetching NFT collections...');
        
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
            // Group NFTs by collection
            response.data.ownedNfts.forEach(nft => {
                const key = nft.contract.address;
                
                if (!collections[key]) {
                    collections[key] = {
                        name: nft.contract.name || 'Unknown Collection',
                        address: nft.contract.address,
                        nfts: [],
                        floorPrice: 0,
                        totalValue: 0
                    };
                }
                
                let image = nft.image?.cachedUrl || 
                           nft.image?.thumbnailUrl || 
                           nft.image?.originalUrl || 
                           '';
                           
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
        
        // Get floor prices for each collection
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
            
            // Sort NFTs within collection (images first)
            collection.nfts.sort((a, b) => {
                if (a.hasImage && !b.hasImage) return -1;
                if (!a.hasImage && b.hasImage) return 1;
                return 0;
            });
        }
        
        // Sort collections by total value (highest first)
        const sortedCollections = Object.values(collections).sort(
            (a, b) => b.totalValue - a.totalValue
        );
        
        console.log(`  ✓ Found ${sortedCollections.length} NFT collections`);
        
        return sortedCollections;
        
    } catch (error) {
        console.error('NFT fetch error:', error);
        return [];
    }
}

// ============================================
// ACTIVITY FETCHING
// ============================================

async function fetchRecentActivity(address) {
    if (!process.env.ETHERSCAN_API_KEY) return [];
    
    try {
        const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc&apikey=${process.env.ETHERSCAN_API_KEY}`;
        
        const response = await axios.get(url);
        
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
        console.error('Activity error:', error);
    }
    
    return [];
}

// ============================================
// HELPER FUNCTIONS
// ============================================

async function resolveENS(ensName) {
    try {
        const address = await providers.ethereum.resolveName(ensName);
        return address;
    } catch (error) {
        console.error('ENS resolution error:', error);
        return null;
    }
}

// ============================================
// DEBUG ENDPOINT
// ============================================

app.get('/api/debug/:address/:chain', async (req, res) => {
    const { address, chain } = req.params;
    
    console.log(`\n🐛 DEBUG: ${address} on ${chain}`);
    
    try {
        // Check if Base is available
        if (chain === 'base' && !process.env.ALCHEMY_API_KEY) {
            return res.status(400).json({ 
                error: 'Base network requires Alchemy API key',
                solution: 'Enable Base Mainnet in your Alchemy dashboard'
            });
        }
        
        const tokens = await fetchAllTokens(address, chain);
        
        res.json({
            chain,
            address,
            tokenCount: tokens.length,
            tokens: tokens.map(t => ({
                symbol: t.symbol,
                balance: t.balance,
                contract: t.contractAddress,
                hasPrice: t.price > 0
            }))
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: error.message,
            details: error.response?.data || 'No additional details'
        });
    }
});

// ============================================
// OTHER ENDPOINTS
// ============================================

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        version: '7.0'
    });
});

app.get('/', (req, res) => {
    res.json({ 
        message: '🚀 eth.af API v7.0',
        features: [
            'Ethereum mainnet tokens ✅',
            'Base L2 tokens (if enabled in Alchemy) ✅',
            'NFT collections with floor prices ✅',
            'Transaction history ✅',
            'DEX price discovery ✅'
        ],
        endpoints: {
            wallet: '/api/wallet/{address-or-ens}',
            debug: '/api/debug/{address}/{chain}',
            health: '/api/health'
        }
    });
});

// ============================================
// START SERVER
// ============================================

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 eth.af Backend v7.0 - Production Ready`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`\n🔑 API Keys:`);
    console.log(`  • Alchemy: ${process.env.ALCHEMY_API_KEY ? '✅ Connected' : '❌ Missing'}`);
    console.log(`  • Etherscan: ${process.env.ETHERSCAN_API_KEY ? '✅ Connected' : '❌ Missing'}`);
    console.log(`\n📝 Notes:`);
    console.log(`  • Base network requires enabling in Alchemy dashboard`);
    console.log(`  • DexScreener provides free price data`);
    console.log(`  • NFT floor prices from OpenSea via Alchemy`);
    console.log(`${'='.repeat(60)}\n`);
});

process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    server.close(() => process.exit(0));
});
