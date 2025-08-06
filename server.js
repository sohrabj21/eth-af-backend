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

// IMPORTANT: Trust proxy BEFORE other middleware
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting with Railway proxy fix
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    message: 'Too many requests, please try again later.',
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false, // Disable the X-RateLimit headers
    // Handler to avoid the proxy issue
    handler: (req, res) => {
        res.status(429).json({
            error: 'Too many requests, please try again later.'
        });
    }
});

// Apply rate limiting to API routes
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
// =====================
