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
    // Customers table optimized for RapidAPI
    db.run(`CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT UNIQUE,
        email TEXT,
        plan TEXT DEFAULT 'rapidapi',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        monthly_limit INTEGER DEFAULT 10000,
        current_usage INTEGER DEFAULT 0,
        last_reset DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'active',
        source TEXT DEFAULT 'rapidapi',
        rapidapi_user_id TEXT
    )`);
    
    // Usage tracking table
    db.run(`CREATE TABLE IF NOT EXISTS api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        endpoint TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        success BOOLEAN,
        file_size INTEGER,
        user_agent TEXT,
        ip_address TEXT
    )`);
    
    // Create demo API keys for testing
    const demoKeys = [
        { key: 'demo-rapidapi-key-123', email: 'demo@rapidapi.com', plan: 'rapidapi', limit: 1000 },
        { key: 'demo-test-key-456', email: 'test@rapidapi.com', plan: 'rapidapi', limit: 5000 },
        { key: 'demo-enterprise-key-789', email: 'enterprise@rapidapi.com', plan: 'rapidapi', limit: 50000 }
    ];
    
    demoKeys.forEach(demo => {
        db.run(`INSERT OR IGNORE INTO customers (api_key, email, plan, monthly_limit, source) VALUES (?, ?, ?, ?, 'demo')`,
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

// RapidAPI Authentication Middleware
const authenticateAPI = (req, res, next) => {
    // Check for RapidAPI headers
    const rapidAPIKey = req.headers['x-rapidapi-key'];
    const rapidAPIHost = req.headers['x-rapidapi-host'];
    const rapidAPIUser = req.headers['x-rapidapi-user'] || 'anonymous';
    
    // For RapidAPI requests
    if (rapidAPIKey && rapidAPIHost && rapidAPIHost.includes('rapidapi.com')) {
        const customerKey = `rapidapi-${rapidAPIUser}-${rapidAPIKey.slice(-8)}`;
        
        // Check if customer exists, create if not
        db.get('SELECT * FROM customers WHERE api_key = ?', [customerKey], (err, customer) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (!customer) {
                // Create new RapidAPI customer
                const newCustomer = {
                    api_key: customerKey,
                    email: `${rapidAPIUser}@rapidapi.customer`,
                    plan: 'rapidapi',
                    monthly_limit: 10000, // Default RapidAPI limit
                    current_usage: 0,
                    source: 'rapidapi',
                    rapidapi_user_id: rapidAPIUser
                };
                
                db.run(`INSERT INTO customers (api_key, email, plan, monthly_limit, source, rapidapi_user_id) 
                        VALUES (?, ?, ?, ?, ?, ?)`,
                    [newCustomer.api_key, newCustomer.email, newCustomer.plan, newCustomer.monthly_limit, newCustomer.source, newCustomer.rapidapi_user_id],
                    function(err) {
                        if (err) {
                            console.error('Error creating RapidAPI customer:', err);
                            return res.status(500).json({ error: 'Failed to create customer record' });
                        }
                        
                        req.customer = { ...newCustomer, id: this.lastID };
                        req.isRapidAPI = true;
                        next();
                    }
                );
            } else {
                // Reset monthly usage if needed
                const now = new Date();
                const lastReset = new Date(customer.last_reset);
                if (now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
                    db.run('UPDATE customers SET current_usage = 0, last_reset = ? WHERE api_key = ?', 
                        [now.toISOString(), customerKey]);
                    customer.current_usage = 0;
                }
                
                req.customer = customer;
                req.isRapidAPI = true;
                next();
            }
        });
        return;
    }
    
    // For demo/testing with direct API keys
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
        return res.status(401).json({ 
            error: 'API key required', 
            message: 'This API is available on RapidAPI. Get your key at: https://rapidapi.com/your-api-name',
            rapidapi_url: 'https://rapidapi.com'
        });
    }
    
    // Handle demo keys for testing
    db.get('SELECT * FROM customers WHERE api_key = ? AND status = "active"', [apiKey], (err, customer) => {
        if (err || !customer) {
            return res.status(401).json({ 
                error: 'Invalid API key',
                message: 'Use this API via RapidAPI for production access',
                rapidapi_url: 'https://rapidapi.com'
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
        if (customer.current_usage >= customer.monthly_limit) {
            return res.status(429).json({ 
                error: 'Demo usage limit exceeded',
                current_usage: customer.current_usage,
                monthly_limit: customer.monthly_limit,
                message: 'Subscribe via RapidAPI for higher limits'
            });
        }
        
        req.customer = customer;
        req.isRapidAPI = false;
        next();
    });
};

// Track API usage
const trackUsage = (endpoint, success = true, fileSize = 0) => {
    return (req, res, next) => {
        const userAgent = req.headers['user-agent'] || 'Unknown';
        const ipAddress = req.ip || req.connection.remoteAddress || 'Unknown';
        
        // Update customer usage
        db.run('UPDATE customers SET current_usage = current_usage + 1 WHERE api_key = ?', 
            [req.customer.api_key]);
        
        // Log detailed usage
        db.run(`INSERT INTO api_usage (api_key, endpoint, success, file_size, user_agent, ip_address) 
                VALUES (?, ?, ?, ?, ?, ?)`,
            [req.customer.api_key, endpoint, success, fileSize, userAgent, ipAddress]);
        
        next();
    };
};

// Rate limiting optimized for RapidAPI
const createRateLimit = (windowMs, maxRequests) => rateLimit({
    windowMs,
    max: maxRequests,
    message: { 
        error: 'Too many requests', 
        message: 'Please wait before making more requests',
        retry_after: Math.ceil(windowMs / 1000)
    },
    standardHeaders: true,
    legacyHeaders: false
});

// ROUTES

// Professional landing page focused on RapidAPI
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PDF API - Available on RapidAPI</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
                
                .header { background: white; padding: 20px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                .nav { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 0 20px; }
                .logo { font-size: 24px; font-weight: bold; color: #2563eb; }
                
                .hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 100px 0; text-align: center; }
                .hero-content { max-width: 800px; margin: 0 auto; padding: 0 20px; }
                .hero h1 { font-size: 3.5rem; font-weight: 700; margin-bottom: 20px; line-height: 1.2; }
                .hero p { font-size: 1.3rem; margin-bottom: 40px; opacity: 0.9; }
                
                .rapidapi-cta { background: #0066cc; color: white; padding: 20px 40px; font-size: 20px; border-radius: 10px; text-decoration: none; display: inline-block; margin: 20px; font-weight: bold; box-shadow: 0 4px 15px rgba(0,102,204,0.3); }
                .rapidapi-cta:hover { background: #0052a3; transform: translateY(-2px); }
                
                .features { padding: 80px 0; background: #f8f9fa; }
                .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; }
                .features h2 { text-align: center; font-size: 2.5rem; margin-bottom: 60px; }
                .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 40px; }
                .feature { background: white; padding: 30px; border-radius: 12px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
                .feature h3 { font-size: 1.4rem; margin-bottom: 15px; color: #1f2937; }
                .feature p { color: #666; }
                
                .rapidapi-benefits { padding: 80px 0; }
                .rapidapi-benefits h2 { text-align: center; font-size: 2.5rem; margin-bottom: 60px; }
                .benefits-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 30px; }
                .benefit { text-align: center; padding: 20px; }
                .benefit h3 { color: #0066cc; margin-bottom: 10px; }
                
                .final-cta { padding: 80px 0; background: #2563eb; color: white; text-align: center; }
                .final-cta h2 { font-size: 2.5rem; margin-bottom: 20px; }
                .final-cta p { font-size: 1.2rem; margin-bottom: 40px; opacity: 0.9; }
                
                .footer { background: #1f2937; color: white; padding: 40px 0; text-align: center; }
                
                @media (max-width: 768px) {
                    .hero h1 { font-size: 2.5rem; }
                }
            </style>
        </head>
        <body>
            <header class="header">
                <nav class="nav">
                    <div class="logo">PDF API</div>
                    <div>
                        <a href="/api/health" style="color: #666; text-decoration: none; margin-right: 20px;">Documentation</a>
                        <a href="#rapidapi" class="rapidapi-cta" style="padding: 10px 20px; font-size: 16px;">Get on RapidAPI</a>
                    </div>
                </nav>
            </header>

            <section class="hero">
                <div class="hero-content">
                    <h1>PDF API for Developers</h1>
                    <p>Replace weeks of PDF development with 3 lines of code. Now available on RapidAPI with one-click integration.</p>
                    <a href="https://rapidapi.com" class="rapidapi-cta">🚀 Get Started on RapidAPI</a>
                    <p style="margin-top: 20px; opacity: 0.8;">Join 12+ million developers on RapidAPI</p>
                </div>
            </section>

            <section class="features">
                <div class="container">
                    <h2>Why Developers Choose Our PDF API</h2>
                    <div class="features-grid">
                        <div class="feature">
                            <h3>⚡ 3-Line Integration</h3>
                            <p>Replace complex PDF libraries with simple HTTP requests. Works with any language, any framework.</p>
                        </div>
                        <div class="feature">
                            <h3>🚀 Production Ready</h3>
                            <p>Built for enterprise scale. We handle infrastructure, scaling, and reliability so you don't have to.</p>
                        </div>
                        <div class="feature">
                            <h3>📊 Usage Analytics</h3>
                            <p>Monitor usage, track performance, and get detailed analytics through RapidAPI's dashboard.</p>
                        </div>
                        <div class="feature">
                            <h3>🔒 Enterprise Security</h3>
                            <p>Secure API authentication with rate limiting and usage tracking built into RapidAPI.</p>
                        </div>
                    </div>
                </div>
            </section>

            <section class="rapidapi-benefits">
                <div class="container">
                    <h2>Available Exclusively on RapidAPI</h2>
                    <div class="benefits-grid">
                        <div class="benefit">
                            <h3>✨ One-Click Subscribe</h3>
                            <p>No complex billing setup. Subscribe and start using immediately.</p>
                        </div>
                        <div class="benefit">
                            <h3>🌍 Global Payments</h3>
                            <p>RapidAPI handles international payments, taxes, and billing.</p>
                        </div>
                        <div class="benefit">
                            <h3>🛠️ Built-in Testing</h3>
                            <p>Test our API directly in RapidAPI's interface before integrating.</p>
                        </div>
                        <div class="benefit">
                            <h3>📈 Usage Dashboard</h3>
                            <p>Monitor your API usage and performance in real-time.</p>
                        </div>
                        <div class="benefit">
                            <h3>🔧 Multiple SDKs</h3>
                            <p>Auto-generated code snippets for every programming language.</p>
                        </div>
                        <div class="benefit">
                            <h3>💬 Community Support</h3>
                            <p>Get help from millions of developers in the RapidAPI community.</p>
                        </div>
                    </div>
                </div>
            </section>

            <section class="final-cta" id="rapidapi">
                <div class="container">
                    <h2>Ready to Stop Building PDF Code?</h2>
                    <p>Join thousands of developers who chose our API over spending weeks with PDF libraries.</p>
                    <a href="https://rapidapi.com" class="rapidapi-cta">🚀 Subscribe on RapidAPI</a>
                    <p style="margin-top: 20px; opacity: 0.8;">30-second setup • Multiple pricing plans • Cancel anytime</p>
                </div>
            </section>

            <footer class="footer">
                <div class="container">
                    <p>&copy; 2025 PDF API. Available exclusively on RapidAPI.</p>
                    <p><a href="/api/health" style="color: #60a5fa;">API Documentation</a></p>
                </div>
            </footer>
        </body>
        </html>
    `);
});

// API health endpoint with RapidAPI focus
app.get('/api/health', (req, res) => {
    res.json({
        status: 'PDF API v4.0 - Optimized for RapidAPI',
        message: 'Production-ready PDF generation API',
        rapidapi_url: 'https://rapidapi.com',
        features: [
            'RapidAPI integration',
            'PDF generation from text',
            'Structured PDF creation',
            'Usage analytics',
            'Enterprise scaling',
            'Global availability'
        ],
        endpoints: {
            generation: [
                'POST /api/generate/text - Generate PDF from text content',
                'POST /api/generate/structured - Create structured PDF with sections'
            ],
            analytics: [
                'GET /api/usage - Get usage statistics',
                'GET /api/account - Get account information'
            ]
        },
        pricing: 'Available on RapidAPI with multiple subscription plans',
        documentation: {
            openapi: '/api/openapi.json',
            rapidapi: 'https://rapidapi.com'
        }
    });
});

// Usage analytics
app.get('/api/usage', authenticateAPI, (req, res) => {
    db.get('SELECT * FROM customers WHERE api_key = ?', [req.customer.api_key], (err, customer) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        
        db.all(`SELECT endpoint, COUNT(*) as count, SUM(file_size) as total_size 
                FROM api_usage WHERE api_key = ? GROUP BY endpoint`,
            [req.customer.api_key], (err, usage) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            
            res.json({
                account: {
                    plan: customer.plan,
                    status: customer.status,
                    source: customer.source,
                    created: customer.created_at
                },
                usage: {
                    current_month: customer.current_usage,
                    monthly_limit: customer.monthly_limit,
                    remaining: customer.monthly_limit - customer.current_usage,
                    percentage_used: Math.round((customer.current_usage / customer.monthly_limit) * 100)
                },
                breakdown: usage || [],
                rapidapi_dashboard: req.isRapidAPI ? 'Available on your RapidAPI dashboard' : null
            });
        });
    });
});

// Account information
app.get('/api/account', authenticateAPI, (req, res) => {
    res.json({
        plan: req.customer.plan,
        api_key: req.customer.api_key.substring(0, 12) + '...',
        current_usage: req.customer.current_usage,
        monthly_limit: req.customer.monthly_limit,
        status: req.customer.status,
        source: req.customer.source,
        member_since: req.customer.created_at,
        rapidapi_user: req.isRapidAPI
    });
});

// PDF generation from text
app.post('/api/generate/text', 
    createRateLimit(15 * 60 * 1000, 100),
    authenticateAPI, 
    trackUsage('generate/text'),
    (req, res) => {
        try {
            const { 
                title = 'Generated PDF',
                text = 'Sample PDF content',
                fontSize = 12,
                author = 'PDF API'
            } = req.body;
            
            if (!text || text.trim().length === 0) {
                return res.status(400).json({ 
                    error: 'Text content is required',
                    message: 'Please provide text content to generate the PDF'
                });
            }
            
            const filename = `text-pdf-${Date.now()}.pdf`;
            const filepath = path.join('uploads', filename);
            
            const doc = new PDFDocument({
                info: {
                    Title: title,
                    Author: author,
                    Subject: 'Generated via PDF API',
                    Creator: 'PDF API v4.0'
                }
            });
            
            doc.pipe(fs.createWriteStream(filepath));
            
            // Professional PDF formatting
            doc.fontSize(20).text(title, { align: 'center' });
            doc.moveDown(2);
            doc.fontSize(fontSize).text(text, { 
                width: 410, 
                align: 'left',
                lineGap: 5
            });
            
            // Footer with API branding
            const pageHeight = doc.page.height;
            doc.fontSize(8).text(
                `Generated by PDF API | ${new Date().toLocaleString()}`, 
                50, 
                pageHeight - 50
            );
            
            doc.end();
            
            res.json({
                success: true,
                message: 'PDF generated successfully',
                filename,
                downloadUrl: `/api/download/${filename}`,
                metadata: {
                    title,
                    pages: 1,
                    fileSize: 'Calculating...',
                    generated_at: new Date().toISOString()
                },
                usage: {
                    calls_remaining: req.customer.monthly_limit - req.customer.current_usage - 1,
                    plan: req.customer.plan
                }
            });
        } catch (error) {
            res.status(500).json({ 
                error: 'PDF generation failed',
                message: error.message 
            });
        }
    }
);

// Structured PDF generation
app.post('/api/generate/structured',
    createRateLimit(15 * 60 * 1000, 50),
    authenticateAPI,
    trackUsage('generate/structured'),
    (req, res) => {
        try {
            const { 
                title = 'Structured Document', 
                sections = [], 
                author = 'PDF API' 
            } = req.body;
            
            if (!sections || sections.length === 0) {
                return res.status(400).json({ 
                    error: 'Sections are required',
                    message: 'Please provide an array of sections to generate the structured PDF'
                });
            }
            
            const filename = `structured-pdf-${Date.now()}.pdf`;
            const filepath = path.join('uploads', filename);
            
            const doc = new PDFDocument({
                info: {
                    Title: title,
                    Author: author,
                    Subject: 'Structured document via PDF API',
                    Creator: 'PDF API v4.0'
                }
            });
            
            doc.pipe(fs.createWriteStream(filepath));
            
            // Title page
            doc.fontSize(24).text(title, { align: 'center' });
            doc.moveDown(3);
            
            // Process sections with enhanced formatting
            sections.forEach((section, index) => {
                if (section.type === 'heading') {
                    doc.fontSize(18)
                       .text(section.content, { 
                           underline: true, 
                           lineGap: 8 
                       });
                    doc.moveDown();
                } else if (section.type === 'paragraph') {
                    doc.fontSize(12)
                       .text(section.content, { 
                           align: 'justify',
                           lineGap: 4
                       });
                    doc.moveDown();
                } else if (section.type === 'list') {
                    section.items.forEach(item => {
                        doc.fontSize(12)
                           .text(`• ${item}`, { 
                               indent: 20,
                               lineGap: 3
                           });
                    });
                    doc.moveDown();
                }
            });
            
            // Footer
            const pageHeight = doc.page.height;
            doc.fontSize(8).text(
                `Generated by PDF API | ${sections.length} sections | ${new Date().toLocaleString()}`, 
                50, 
                pageHeight - 50
            );
            
            doc.end();
            
            res.json({
                success: true,
                message: 'Structured PDF generated successfully',
                filename,
                downloadUrl: `/api/download/${filename}`,
                metadata: {
                    title,
                    sections: sections.length,
                    pages: Math.ceil(sections.length / 3), // Rough estimate
                    generated_at: new Date().toISOString()
                },
                usage: {
                    calls_remaining: req.customer.monthly_limit - req.customer.current_usage - 1,
                    plan: req.customer.plan
                }
            });
        } catch (error) {
            res.status(500).json({ 
                error: 'Structured PDF generation failed',
                message: error.message 
            });
        }
    }
);

// File download
app.get('/api/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join('uploads', filename);
    
    if (fs.existsSync(filepath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.sendFile(path.resolve(filepath));
    } else {
        res.status(404).json({ 
            error: 'File not found',
            message: 'The requested PDF file does not exist or has expired'
        });
    }
});

// OpenAPI specification endpoint for RapidAPI
app.get('/api/openapi.json', (req, res) => {
    res.json({
        openapi: '3.0.0',
        info: {
            title: 'PDF API - Stop Building PDF Code',
            version: '4.0.0',
            description: 'Production-ready PDF API optimized for RapidAPI integration'
        },
        servers: [
            { url: 'https://pdf-api-yl9j.onrender.com', description: 'Production server' }
        ],
        paths: {
            '/api/generate/text': {
                post: {
                    summary: 'Generate PDF from text',
                    description: 'Create a PDF document from simple text content'
                }
            },
            '/api/generate/structured': {
                post: {
                    summary: 'Generate structured PDF',
                    description: 'Create a PDF with structured content including headings and lists'
                }
            }
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        message: 'This endpoint does not exist',
        documentation: '/api/health'
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ 
                error: 'File too large', 
                message: 'Maximum file size is 10MB' 
            });
        }
    }
    
    console.error('API Error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        message: 'Something went wrong processing your request'
    });
});

app.listen(port, () => {
    console.log(`🚀 PDF API v4.0 - RapidAPI Optimized`);
    console.log(`🌐 Server: http://localhost:${port}`);
    console.log(`📋 Health: http://localhost:${port}/api/health`);
    console.log(`🔗 RapidAPI Ready: Optimized for marketplace integration`);
    console.log(`💡 Focus: Pure PDF functionality with maximum adoption`);
});
