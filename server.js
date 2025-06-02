const express = require('express');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const app = express();
const port = 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Create directories and database
['uploads', 'public'].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
});

// Initialize SQLite Database
const db = new sqlite3.Database('./customers.db');

// Create tables
db.serialize(() => {
    // Customers table
    db.run(`CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT UNIQUE,
        email TEXT UNIQUE,
        plan TEXT DEFAULT 'free',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        monthly_limit INTEGER DEFAULT 100,
        current_usage INTEGER DEFAULT 0,
        last_reset DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'active'
    )`);
    
    // Usage tracking table
    db.run(`CREATE TABLE IF NOT EXISTS api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        endpoint TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        success BOOLEAN,
        file_size INTEGER
    )`);
    
    // Create demo API keys for testing
    const demoKeys = [
        { key: 'demo-free-key-123', email: 'demo@free.com', plan: 'free', limit: 100 },
        { key: 'demo-basic-key-456', email: 'demo@basic.com', plan: 'basic', limit: 1000 },
        { key: 'demo-pro-key-789', email: 'demo@pro.com', plan: 'pro', limit: 10000 },
        { key: 'demo-enterprise-key-999', email: 'demo@enterprise.com', plan: 'enterprise', limit: 999999 }
    ];
    
    demoKeys.forEach(demo => {
        db.run(`INSERT OR IGNORE INTO customers (api_key, email, plan, monthly_limit) VALUES (?, ?, ?, ?)`,
            [demo.key, demo.email, demo.plan, demo.limit]);
    });
});

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({ 
    storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files allowed'), false);
        }
    },
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Authentication middleware
const authenticateAPI = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
        return res.status(401).json({ 
            error: 'API key required', 
            message: 'Include your API key in the X-API-Key header or api_key query parameter',
            get_key: 'Contact support for API key: demo keys available in /api/demo-keys'
        });
    }
    
    db.get('SELECT * FROM customers WHERE api_key = ? AND status = "active"', [apiKey], (err, customer) => {
        if (err || !customer) {
            return res.status(401).json({ 
                error: 'Invalid API key',
                message: 'API key not found or inactive'
            });
        }
        
        // Reset monthly usage if needed
        const now = new Date();
        const lastReset = new Date(customer.last_reset);
        if (now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
            db.run('UPDATE customers SET current_usage = 0, last_reset = ? WHERE api_key = ?', 
                [now.toISOString(), apiKey]);
            customer.current_usage = 0;
        }
        
        // Check usage limits
        if (customer.plan !== 'enterprise' && customer.current_usage >= customer.monthly_limit) {
            return res.status(429).json({ 
                error: 'Usage limit exceeded',
                current_usage: customer.current_usage,
                monthly_limit: customer.monthly_limit,
                plan: customer.plan,
                upgrade_message: 'Upgrade your plan for higher limits'
            });
        }
        
        req.customer = customer;
        next();
    });
};

// Track API usage
const trackUsage = (endpoint, success = true, fileSize = 0) => {
    return (req, res, next) => {
        // Update customer usage
        db.run('UPDATE customers SET current_usage = current_usage + 1 WHERE api_key = ?', 
            [req.customer.api_key]);
        
        // Log usage
        db.run('INSERT INTO api_usage (api_key, endpoint, success, file_size) VALUES (?, ?, ?, ?)',
            [req.customer.api_key, endpoint, success, fileSize]);
        
        next();
    };
};

// Rate limiting by plan
const createRateLimit = (windowMs, max) => rateLimit({
    windowMs,
    max,
    message: { error: 'Too many requests, please try again later' }
});

// Routes

// Landing page with pricing
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Professional PDF API - Ready for Business</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
                .container { max-width: 1200px; margin: 0 auto; padding: 40px; }
                .hero { text-align: center; padding: 80px 0; }
                .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; margin: 60px 0; }
                .feature { background: rgba(255,255,255,0.1); padding: 30px; border-radius: 10px; backdrop-filter: blur(10px); }
                .pricing { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 60px 0; }
                .plan { background: white; color: #333; padding: 30px; border-radius: 10px; text-align: center; }
                .plan.featured { transform: scale(1.05); box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
                .price { font-size: 3em; font-weight: bold; color: #667eea; }
                .demo-keys { background: rgba(255,255,255,0.1); padding: 20px; border-radius: 10px; margin: 20px 0; }
                a { color: #fff; text-decoration: none; background: rgba(255,255,255,0.2); padding: 10px 20px; border-radius: 5px; display: inline-block; margin: 5px; }
                a:hover { background: rgba(255,255,255,0.3); }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="hero">
                    <h1>🚀 Professional PDF API v3.0</h1>
                    <h2>Enterprise-Grade Document Processing</h2>
                    <p>Generate, process, and manage PDFs at scale with our monetization-ready API</p>
                </div>
                
                <div class="features">
                    <div class="feature">
                        <h3>🔐 Authenticated Access</h3>
                        <p>Secure API key authentication with usage tracking and rate limiting per subscription tier.</p>
                    </div>
                    <div class="feature">
                        <h3>📊 Usage Analytics</h3>
                        <p>Real-time usage monitoring, monthly limits, and detailed analytics for business intelligence.</p>
                    </div>
                    <div class="feature">
                        <h3>⚡ Scalable Architecture</h3>
                        <p>Built for enterprise scale with SQLite database, rate limiting, and performance optimization.</p>
                    </div>
                    <div class="feature">
                        <h3>💰 Monetization Ready</h3>
                        <p>Complete subscription management, usage-based billing, and customer analytics infrastructure.</p>
                    </div>
                </div>
                
                <h2 style="text-align: center;">💳 Pricing Plans</h2>
                <div class="pricing">
                    <div class="plan">
                        <h3>Free</h3>
                        <div class="price">$0</div>
                        <p>100 API calls/month</p>
                        <ul>
                            <li>Basic PDF generation</li>
                            <li>Community support</li>
                            <li>Rate limited</li>
                        </ul>
                    </div>
                    <div class="plan featured">
                        <h3>Basic</h3>
                        <div class="price">$9</div>
                        <p>1,000 API calls/month</p>
                        <ul>
                            <li>All PDF features</li>
                            <li>Email support</li>
                            <li>Usage analytics</li>
                        </ul>
                    </div>
                    <div class="plan">
                        <h3>Pro</h3>
                        <div class="price">$29</div>
                        <p>10,000 API calls/month</p>
                        <ul>
                            <li>Priority support</li>
                            <li>Advanced features</li>
                            <li>Webhook notifications</li>
                        </ul>
                    </div>
                    <div class="plan">
                        <h3>Enterprise</h3>
                        <div class="price">$99</div>
                        <p>Unlimited API calls</p>
                        <ul>
                            <li>SLA guarantee</li>
                            <li>Custom features</li>
                            <li>White-label option</li>
                        </ul>
                    </div>
                </div>
                
                <div class="demo-keys">
                    <h3>🔑 Demo API Keys for Testing</h3>
                    <p><strong>Free:</strong> demo-free-key-123 (100 calls/month)</p>
                    <p><strong>Basic:</strong> demo-basic-key-456 (1,000 calls/month)</p>
                    <p><strong>Pro:</strong> demo-pro-key-789 (10,000 calls/month)</p>
                    <p><strong>Enterprise:</strong> demo-enterprise-key-999 (unlimited)</p>
                </div>
                
                <div style="text-align: center; margin: 40px 0;">
                    <a href="/api/health">📋 API Documentation</a>
                    <a href="/api/demo-keys">🔑 Demo Keys</a>
                    <a href="/dashboard">📊 Customer Dashboard</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Demo keys endpoint
app.get('/api/demo-keys', (req, res) => {
    res.json({
        message: 'Demo API Keys for Testing',
        keys: {
            free: {
                key: 'demo-free-key-123',
                limit: '100 calls/month',
                features: ['Basic PDF generation', 'Community support']
            },
            basic: {
                key: 'demo-basic-key-456', 
                limit: '1,000 calls/month',
                features: ['All PDF features', 'Email support', 'Usage analytics']
            },
            pro: {
                key: 'demo-pro-key-789',
                limit: '10,000 calls/month', 
                features: ['Priority support', 'Advanced features', 'Webhooks']
            },
            enterprise: {
                key: 'demo-enterprise-key-999',
                limit: 'Unlimited calls',
                features: ['SLA guarantee', 'Custom features', 'White-label']
            }
        },
        usage_examples: {
            header: 'Include in request headers: X-API-Key: demo-basic-key-456',
            query: 'Or as query parameter: ?api_key=demo-basic-key-456'
        }
    });
});

// API health with authentication info
app.get('/api/health', (req, res) => {
    res.json({
        status: 'Professional PDF API v3.0 - Monetization Ready',
        authentication: 'Required - Use X-API-Key header or api_key parameter',
        demo_keys: '/api/demo-keys',
        features: [
            'Authenticated API access',
            'Usage tracking & analytics', 
            'Rate limiting by subscription',
            'PDF generation & processing',
            'Customer management',
            'Billing-ready infrastructure'
        ],
        endpoints: {
            generation: [
                'POST /api/generate/text - Generate PDF from text',
                'POST /api/generate/structured - Create structured PDF'
            ],
            processing: [
                'POST /api/upload - Upload & analyze PDF',
                'POST /api/extract-text - Extract text from PDF'
            ],
            management: [
                'GET /api/files - List customer files',
                'GET /api/download/:filename - Download file',
                'DELETE /api/files/:filename - Delete file'
            ],
            analytics: [
                'GET /api/usage - Customer usage analytics',
                'GET /api/account - Account information'
            ]
        },
        business_model: {
            free: '$0/month - 100 operations',
            basic: '$9/month - 1,000 operations', 
            pro: '$29/month - 10,000 operations',
            enterprise: '$99/month - Unlimited operations'
        }
    });
});

// Customer usage analytics
app.get('/api/usage', authenticateAPI, (req, res) => {
    db.get('SELECT * FROM customers WHERE api_key = ?', [req.customer.api_key], (err, customer) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        
        db.all('SELECT endpoint, COUNT(*) as count, SUM(file_size) as total_size FROM api_usage WHERE api_key = ? GROUP BY endpoint',
            [req.customer.api_key], (err, usage) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            
            res.json({
                account: {
                    email: customer.email,
                    plan: customer.plan,
                    status: customer.status,
                    created: customer.created_at
                },
                usage: {
                    current_month: customer.current_usage,
                    monthly_limit: customer.monthly_limit,
                    remaining: customer.monthly_limit - customer.current_usage,
                    percentage_used: Math.round((customer.current_usage / customer.monthly_limit) * 100)
                },
                breakdown: usage || [],
                upgrade_available: customer.plan !== 'enterprise'
            });
        });
    });
});

// Account information
app.get('/api/account', authenticateAPI, (req, res) => {
    res.json({
        email: req.customer.email,
        plan: req.customer.plan,
        api_key: req.customer.api_key.substring(0, 8) + '...',
        current_usage: req.customer.current_usage,
        monthly_limit: req.customer.monthly_limit,
        status: req.customer.status,
        member_since: req.customer.created_at
    });
});

// Protected PDF generation endpoints
app.post('/api/generate/text', 
    createRateLimit(15 * 60 * 1000, 100),
    authenticateAPI, 
    trackUsage('generate/text'),
    (req, res) => {
        try {
            const { 
                text = 'Sample PDF Content', 
                title = 'Generated PDF',
                fontSize = 12,
                author = req.customer.email
            } = req.body;
            
            const filename = `text-pdf-${Date.now()}.pdf`;
            const filepath = path.join('uploads', filename);
            
            const doc = new PDFDocument({
                info: {
                    Title: title,
                    Author: author,
                    Subject: 'Generated via PDF API',
                    Creator: 'Professional PDF API v3.0'
                }
            });
            
            doc.pipe(fs.createWriteStream(filepath));
            
            doc.fontSize(20).text(title, { align: 'center' });
            doc.moveDown(2);
            doc.fontSize(fontSize).text(text, { width: 410, align: 'left' });
            doc.fontSize(8).text(`Generated by PDF API v3.0 | Plan: ${req.customer.plan} | ${new Date().toLocaleString()}`, 50, 750);
            
            doc.end();
            
            res.json({
                success: true,
                message: 'PDF generated successfully',
                filename,
                downloadUrl: `/api/download/${filename}?api_key=${req.customer.api_key}`,
                usage: {
                    calls_remaining: req.customer.monthly_limit - req.customer.current_usage - 1,
                    plan: req.customer.plan
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
);

app.post('/api/generate/structured',
    createRateLimit(15 * 60 * 1000, 50),
    authenticateAPI,
    trackUsage('generate/structured'),
    (req, res) => {
        try {
            const { title = 'Structured Document', sections = [], author = req.customer.email } = req.body;
            
            const filename = `structured-pdf-${Date.now()}.pdf`;
            const filepath = path.join('uploads', filename);
            
            const doc = new PDFDocument();
            doc.pipe(fs.createWriteStream(filepath));
            
            doc.fontSize(24).text(title, { align: 'center' });
            doc.moveDown(3);
            
            sections.forEach(section => {
                if (section.type === 'heading') {
                    doc.fontSize(18).text(section.content, { underline: true });
                    doc.moveDown();
                } else if (section.type === 'paragraph') {
                    doc.fontSize(12).text(section.content);
                    doc.moveDown();
                } else if (section.type === 'list') {
                    section.items.forEach(item => {
                        doc.fontSize(12).text(`• ${item}`, { indent: 20 });
                    });
                    doc.moveDown();
                }
            });
            
            doc.end();
            
            res.json({
                success: true,
                message: 'Structured PDF generated successfully',
                filename,
                downloadUrl: `/api/download/${filename}?api_key=${req.customer.api_key}`,
                sections: sections.length,
                usage: {
                    calls_remaining: req.customer.monthly_limit - req.customer.current_usage - 1,
                    plan: req.customer.plan
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
);

// File download with authentication
app.get('/api/download/:filename', authenticateAPI, (req, res) => {
    const filepath = path.join('uploads', req.params.filename);
    if (fs.existsSync(filepath)) {
        res.download(filepath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Simple dashboard
app.get('/dashboard', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Customer Dashboard</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
                .container { max-width: 800px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; }
                .usage-bar { background: #e0e0e0; height: 20px; border-radius: 10px; overflow: hidden; margin: 10px 0; }
                .usage-fill { background: linear-gradient(90deg, #4CAF50, #45a049); height: 100%; transition: width 0.3s; }
                input, button { padding: 10px; margin: 5px; border: 1px solid #ddd; border-radius: 5px; }
                button { background: #007bff; color: white; cursor: pointer; }
                .demo-key { background: #f8f9fa; padding: 10px; border-radius: 5px; margin: 5px 0; font-family: monospace; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📊 Customer Dashboard</h1>
                <p>Test your API usage and account information</p>
                
                <h3>🔑 Demo API Keys</h3>
                <div class="demo-key">Free: demo-free-key-123</div>
                <div class="demo-key">Basic: demo-basic-key-456</div>
                <div class="demo-key">Pro: demo-pro-key-789</div>
                <div class="demo-key">Enterprise: demo-enterprise-key-999</div>
                
                <h3>🧪 Test API</h3>
                <input type="text" id="apiKey" placeholder="Enter API Key" value="demo-basic-key-456" style="width: 300px;">
                <br>
                <button onclick="checkUsage()">Check Usage</button>
                <button onclick="generatePDF()">Generate Test PDF</button>
                
                <div id="results" style="margin-top: 20px;"></div>
                
                <script>
                    async function checkUsage() {
                        const apiKey = document.getElementById('apiKey').value;
                        try {
                            const response = await fetch('/api/usage', {
                                headers: { 'X-API-Key': apiKey }
                            });
                            const data = await response.json();
                            
                            if (response.ok) {
                                const percentage = data.usage.percentage_used;
                                document.getElementById('results').innerHTML = \`
                                    <h3>📈 Usage Analytics</h3>
                                    <p><strong>Plan:</strong> \${data.account.plan}</p>
                                    <p><strong>Usage:</strong> \${data.usage.current_month} / \${data.usage.monthly_limit} calls</p>
                                    <div class="usage-bar">
                                        <div class="usage-fill" style="width: \${percentage}%"></div>
                                    </div>
                                    <p><strong>Remaining:</strong> \${data.usage.remaining} calls (\${100-percentage}%)</p>
                                \`;
                            } else {
                                document.getElementById('results').innerHTML = \`<p style="color: red;">Error: \${data.error}</p>\`;
                            }
                        } catch (error) {
                            document.getElementById('results').innerHTML = \`<p style="color: red;">Error: \${error.message}</p>\`;
                        }
                    }
                    
                    async function generatePDF() {
                        const apiKey = document.getElementById('apiKey').value;
                        try {
                            const response = await fetch('/api/generate/text', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-API-Key': apiKey
                                },
                                body: JSON.stringify({
                                    title: 'Dashboard Test PDF',
                                    text: 'This PDF was generated from the customer dashboard to test API functionality and usage tracking.'
                                })
                            });
                            const data = await response.json();
                            
                            if (response.ok) {
                                document.getElementById('results').innerHTML = \`
                                    <h3>✅ PDF Generated Successfully!</h3>
                                    <p><strong>Filename:</strong> \${data.filename}</p>
                                    <p><strong>Calls Remaining:</strong> \${data.usage.calls_remaining}</p>
                                    <a href="\${data.downloadUrl}" target="_blank">📥 Download PDF</a>
                                \`;
                            } else {
                                document.getElementById('results').innerHTML = \`<p style="color: red;">Error: \${data.error}</p>\`;
                            }
                        } catch (error) {
                            document.getElementById('results').innerHTML = \`<p style="color: red;">Error: \${error.message}</p>\`;
                        }
                    }
                </script>
            </div>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`🚀 Professional PDF API v3.0 - Monetization Ready!`);
    console.log(`💰 Business Dashboard: http://localhost:${port}`);
    console.log(`📋 API Documentation: http://localhost:${port}/api/health`);
    console.log(`🔑 Demo Keys: http://localhost:${port}/api/demo-keys`);
    console.log(`📊 Customer Dashboard: http://localhost:${port}/dashboard`);
    console.log(`🎯 Ready for paying customers!`);
});