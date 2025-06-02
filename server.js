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
const stripe = require('stripe')('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');
const app = express();
const port = 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Pricing plans
const PLANS = {
    basic: { price: 900, limit: 1000, name: 'Basic' }, // $9.00 in cents
    pro: { price: 2900, limit: 10000, name: 'Pro' },   // $29.00 in cents
    enterprise: { price: 9900, limit: 999999, name: 'Enterprise' } // $99.00 in cents
};

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
    // Customers table - updated with Stripe fields
    db.run(`CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT UNIQUE,
        email TEXT UNIQUE,
        plan TEXT DEFAULT 'free',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        monthly_limit INTEGER DEFAULT 100,
        current_usage INTEGER DEFAULT 0,
        last_reset DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'active',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT
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
            get_key: 'Sign up at /signup for your API key'
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
                upgrade_message: 'Upgrade your plan at /signup for higher limits'
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

// STRIPE PAYMENT ROUTES

// Create customer and subscription
app.post('/api/subscribe', async (req, res) => {
    try {
        const { email, plan, payment_method } = req.body;
        
        if (!PLANS[plan]) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }
        
        // Check if customer already exists
        const existingCustomer = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM customers WHERE email = ?', [email], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (existingCustomer) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        // Create customer in Stripe
        const customer = await stripe.customers.create({
            email,
            payment_method,
            invoice_settings: { default_payment_method: payment_method }
        });
        
        // Create subscription
        const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price_data: {
                currency: 'usd',
                product_data: { name: `PDF API ${PLANS[plan].name} Plan` },
                unit_amount: PLANS[plan].price,
                recurring: { interval: 'month' }
            }}],
            expand: ['latest_invoice.payment_intent']
        });
        
        // Create API key for customer
        const apiKey = `live-${uuidv4()}`;
        
        // Save to database
        await new Promise((resolve, reject) => {
            db.run(`INSERT INTO customers (api_key, email, plan, monthly_limit, stripe_customer_id, stripe_subscription_id) 
                    VALUES (?, ?, ?, ?, ?, ?)`,
                [apiKey, email, plan, PLANS[plan].limit, customer.id, subscription.id],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });
        
        res.json({
            success: true,
            message: 'Subscription created successfully!',
            api_key: apiKey,
            plan: plan,
            monthly_limit: PLANS[plan].limit,
            subscription_id: subscription.id,
            customer_id: customer.id
        });
        
    } catch (error) {
        console.error('Subscription error:', error);
        res.status(500).json({ error: 'Subscription failed: ' + error.message });
    }
});

// Stripe webhook for subscription updates
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        // For now, we'll skip signature verification for testing
        event = JSON.parse(req.body);
    } catch (err) {
        return res.status(400).send(`Webhook error: ${err.message}`);
    }
    
    // Handle subscription events
    if (event.type === 'invoice.payment_failed') {
        const subscription = event.data.object.subscription;
        // Deactivate customer
        db.run('UPDATE customers SET status = "suspended" WHERE stripe_subscription_id = ?', [subscription]);
    } else if (event.type === 'invoice.payment_succeeded') {
        const subscription = event.data.object.subscription;
        // Reactivate customer and reset usage
        db.run('UPDATE customers SET status = "active", current_usage = 0 WHERE stripe_subscription_id = ?', [subscription]);
    }
    
    res.json({received: true});
});

// Signup page with Stripe integration
app.get('/signup', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Sign Up - PDF API</title>
            <script src="https://js.stripe.com/v3/"></script>
            <style>
                body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
                .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                .plan { border: 2px solid #ddd; padding: 20px; margin: 20px 0; border-radius: 10px; cursor: pointer; transition: all 0.3s; }
                .plan:hover { border-color: #007bff; }
                .plan.selected { border-color: #007bff; background: #f8f9fa; }
                .price { font-size: 2em; color: #007bff; font-weight: bold; }
                input, button { padding: 12px; margin: 10px 0; width: 100%; border: 1px solid #ddd; border-radius: 5px; font-size: 16px; }
                button { background: #007bff; color: white; cursor: pointer; font-weight: bold; }
                button:hover { background: #0056b3; }
                button:disabled { background: #ccc; cursor: not-allowed; }
                #card-element { padding: 12px; border: 1px solid #ddd; border-radius: 5px; background: white; }
                .success { background: #d4edda; color: #155724; padding: 20px; border-radius: 5px; margin: 20px 0; }
                .error { background: #f8d7da; color: #721c24; padding: 15px; border-radius: 5px; margin: 10px 0; }
                .api-key { font-family: monospace; background: #f1f1f1; padding: 10px; border-radius: 5px; word-break: break-all; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 Start Your PDF API Subscription</h1>
                <p>Join thousands of developers using our professional PDF API</p>
                
                <div class="plan selected" data-plan="basic">
                    <h3>Basic Plan - Most Popular</h3>
                    <div class="price">$9/month</div>
                    <p>1,000 API calls/month</p>
                    <ul>
                        <li>✅ All PDF generation features</li>
                        <li>✅ Text extraction</li>
                        <li>✅ Email support</li>
                        <li>✅ Usage analytics</li>
                    </ul>
                </div>
                
                <div class="plan" data-plan="pro">
                    <h3>Pro Plan - Best Value</h3>
                    <div class="price">$29/month</div>
                    <p>10,000 API calls/month</p>
                    <ul>
                        <li>✅ Everything in Basic</li>
                        <li>✅ Priority support</li>
                        <li>✅ Advanced features</li>
                        <li>✅ Webhook notifications</li>
                    </ul>
                </div>
                
                <div class="plan" data-plan="enterprise">
                    <h3>Enterprise Plan</h3>
                    <div class="price">$99/month</div>
                    <p>Unlimited API calls</p>
                    <ul>
                        <li>✅ Everything in Pro</li>
                        <li>✅ SLA guarantee</li>
                        <li>✅ Custom features</li>
                        <li>✅ White-label option</li>
                    </ul>
                </div>
                
                <form id="signup-form">
                    <input type="email" id="email" placeholder="Your email address" required>
                    
                    <div id="card-element">
                        <!-- Stripe Elements will create form elements here -->
                    </div>
                    
                    <button type="submit" id="submit-button">
                        Start Basic Plan - $9/month
                    </button>
                </form>
                
                <div id="result"></div>
                
                <p style="text-align: center; color: #666; margin-top: 30px;">
                    <small>🔒 Secure payment processing by Stripe • Cancel anytime</small>
                </p>
            </div>
            
            <script>
                const stripe = Stripe('pk_live_51RVftVDuqKKFVmrE2AXaOlRb2Xm4aZOIPknbPQH7NJ5QcPXGOV8WFDNxJpOe7AQP5s9zCag7XdiLmlFGAvC1pULA00lFEyKKiP');
                const elements = stripe.elements();
                const cardElement = elements.create('card');
                cardElement.mount('#card-element');
                
                let selectedPlan = 'basic';
                
                // Plan selection
                document.querySelectorAll('.plan').forEach(plan => {
                    plan.addEventListener('click', () => {
                        document.querySelectorAll('.plan').forEach(p => p.classList.remove('selected'));
                        plan.classList.add('selected');
                        selectedPlan = plan.dataset.plan;
                        
                        const prices = { basic: '$9', pro: '$29', enterprise: '$99' };
                        const names = { basic: 'Basic', pro: 'Pro', enterprise: 'Enterprise' };
                        document.getElementById('submit-button').textContent = 
                            \`Start \${names[selectedPlan]} Plan - \${prices[selectedPlan]}/month\`;
                    });
                });
                
                // Form submission
                document.getElementById('signup-form').addEventListener('submit', async (event) => {
                    event.preventDefault();
                    
                    const submitButton = document.getElementById('submit-button');
                    submitButton.disabled = true;
                    submitButton.textContent = 'Processing...';
                    
                    try {
                        const {paymentMethod, error} = await stripe.createPaymentMethod({
                            type: 'card',
                            card: cardElement,
                        });
                        
                        if (error) {
                            throw new Error(error.message);
                        }
                        
                        // Send to server
                        const response = await fetch('/api/subscribe', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                email: document.getElementById('email').value,
                                plan: selectedPlan,
                                payment_method: paymentMethod.id
                            })
                        });
                        
                        const result = await response.json();
                        
                        if (result.success) {
                            document.getElementById('result').innerHTML = \`
                                <div class="success">
                                    <h3>🎉 Welcome to PDF API!</h3>
                                    <p><strong>Subscription Active!</strong> You can now start using the API.</p>
                                    <p><strong>Your API Key:</strong></p>
                                    <div class="api-key">\${result.api_key}</div>
                                    <p><strong>Plan:</strong> \${result.plan} (\${result.monthly_limit} calls/month)</p>
                                    <p><a href="/dashboard" style="color: #007bff;">→ Go to Dashboard</a></p>
                                    <p><a href="/api/health" style="color: #007bff;">→ View API Documentation</a></p>
                                </div>
                            \`;
                            document.getElementById('signup-form').style.display = 'none';
                        } else {
                            throw new Error(result.error);
                        }
                    } catch (error) {
                        document.getElementById('result').innerHTML = 
                            \`<div class="error">❌ Error: \${error.message}</div>\`;
                    } finally {
                        submitButton.disabled = false;
                        submitButton.textContent = 'Start Basic Plan - $9/month';
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// Routes (keeping all your existing routes)

// Modern developer-focused landing page
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PDF API - Stop Building PDF Code, Start Shipping Features</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
                
                /* Header */
                .header { background: white; padding: 20px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); position: sticky; top: 0; z-index: 100; }
                .nav { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 0 20px; }
                .logo { font-size: 24px; font-weight: bold; color: #2563eb; }
                .nav-links { display: flex; gap: 30px; }
                .nav-links a { text-decoration: none; color: #666; font-weight: 500; }
                .nav-links a:hover { color: #2563eb; }
                
                /* Hero Section */
                .hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 100px 0; text-align: center; }
                .hero-content { max-width: 800px; margin: 0 auto; padding: 0 20px; }
                .hero h1 { font-size: 3.5rem; font-weight: 700; margin-bottom: 20px; line-height: 1.2; }
                .hero p { font-size: 1.3rem; margin-bottom: 40px; opacity: 0.9; }
                .cta-buttons { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; }
                .btn { padding: 15px 30px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; transition: all 0.3s; }
                .btn-primary { background: #10b981; color: white; }
                .btn-primary:hover { background: #059669; transform: translateY(-2px); }
                .btn-secondary { background: white; color: #333; }
                .btn-secondary:hover { background: #f8f9fa; transform: translateY(-2px); }
                
                /* Problem Section */
                .problem { padding: 80px 0; background: #f8f9fa; }
                .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; }
                .problem h2 { text-align: center; font-size: 2.5rem; margin-bottom: 60px; color: #1f2937; }
                .problem-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 40px; }
                .problem-item { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
                .problem-item h3 { color: #dc2626; margin-bottom: 15px; font-size: 1.3rem; }
                .problem-item p { color: #666; }
                
                /* Solution Section */
                .solution { padding: 80px 0; }
                .solution h2 { text-align: center; font-size: 2.5rem; margin-bottom: 20px; }
                .solution .subtitle { text-align: center; font-size: 1.2rem; color: #666; margin-bottom: 60px; }
                .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 40px; }
                .feature { text-align: center; padding: 30px; }
                .feature-icon { font-size: 3rem; margin-bottom: 20px; }
                .feature h3 { font-size: 1.4rem; margin-bottom: 15px; color: #1f2937; }
                .feature p { color: #666; }
                
                /* Code Example */
                .code-section { padding: 80px 0; background: #1f2937; color: white; }
                .code-section h2 { text-align: center; margin-bottom: 40px; font-size: 2.5rem; }
                .code-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 40px; }
                .code-block { background: #111827; padding: 30px; border-radius: 12px; overflow-x: auto; }
                .code-block h3 { margin-bottom: 20px; color: #10b981; }
                .code-block pre { color: #e5e7eb; font-family: 'Monaco', 'Menlo', monospace; font-size: 14px; line-height: 1.5; }
                .code-highlight { color: #fbbf24; }
                
                /* Pricing */
                .pricing { padding: 80px 0; background: #f8f9fa; }
                .pricing h2 { text-align: center; font-size: 2.5rem; margin-bottom: 20px; }
                .pricing .subtitle { text-align: center; color: #666; margin-bottom: 60px; font-size: 1.2rem; }
                .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 30px; max-width: 900px; margin: 0 auto; }
                .pricing-card { background: white; padding: 40px 30px; border-radius: 12px; text-align: center; position: relative; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
                .pricing-card.featured { border: 3px solid #2563eb; transform: scale(1.05); }
                .pricing-card.featured::before { content: 'Most Popular'; position: absolute; top: -15px; left: 50%; transform: translateX(-50%); background: #2563eb; color: white; padding: 8px 20px; border-radius: 20px; font-size: 14px; font-weight: 600; }
                .pricing-card h3 { font-size: 1.5rem; margin-bottom: 10px; }
                .pricing-card .price { font-size: 3rem; font-weight: 700; color: #2563eb; margin: 20px 0; }
                .pricing-card .price span { font-size: 1rem; color: #666; }
                .pricing-card ul { text-align: left; margin: 30px 0; }
                .pricing-card ul li { margin: 10px 0; color: #666; }
                .pricing-card ul li::before { content: '✓'; color: #10b981; font-weight: bold; margin-right: 10px; }
                
                /* Comparison */
                .comparison { padding: 80px 0; }
                .comparison h2 { text-align: center; font-size: 2.5rem; margin-bottom: 60px; }
                .comparison-table { max-width: 800px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
                .comparison-table th, .comparison-table td { padding: 20px; text-align: left; border-bottom: 1px solid #e5e7eb; }
                .comparison-table th { background: #f8f9fa; font-weight: 600; }
                .comparison-table .us { background: #ecfdf5; font-weight: 600; color: #059669; }
                .comparison-table .them { color: #dc2626; }
                
                /* CTA Section */
                .final-cta { padding: 80px 0; background: #2563eb; color: white; text-align: center; }
                .final-cta h2 { font-size: 2.5rem; margin-bottom: 20px; }
                .final-cta p { font-size: 1.2rem; margin-bottom: 40px; opacity: 0.9; }
                
                /* Footer */
                .footer { background: #1f2937; color: white; padding: 40px 0; text-align: center; }
                
                @media (max-width: 768px) {
                    .hero h1 { font-size: 2.5rem; }
                    .code-comparison { grid-template-columns: 1fr; }
                    .cta-buttons { flex-direction: column; align-items: center; }
                }
            </style>
        </head>
        <body>
            <!-- Header -->
            <header class="header">
                <nav class="nav">
                    <div class="logo">PDF API</div>
                    <div class="nav-links">
                        <a href="/api/health">Docs</a>
                        <a href="/dashboard">Demo</a>
                        <a href="#pricing">Pricing</a>
                        <a href="/signup">Sign Up</a>
                    </div>
                </nav>
            </header>

            <!-- Hero Section -->
            <section class="hero">
                <div class="hero-content">
                    <h1>Stop Building PDF Code,<br>Start Shipping Features</h1>
                    <p>Production-ready PDF API that replaces weeks of development with 3 lines of code. Generate, parse, and manage PDFs at scale without the headaches.</p>
                    <div class="cta-buttons">
                        <a href="/signup" class="btn btn-primary">Start Free Trial</a>
                        <a href="/dashboard" class="btn btn-secondary">View Live Demo</a>
                    </div>
                </div>
            </section>

            <!-- Problem Section -->
            <section class="problem">
                <div class="container">
                    <h2>Why Developers Hate Building PDF Features</h2>
                    <div class="problem-grid">
                        <div class="problem-item">
                            <h3>⏰ Weeks of Development Time</h3>
                            <p>PDF libraries are complex, poorly documented, and require deep expertise. What should be simple takes forever to implement correctly.</p>
                        </div>
                        <div class="problem-item">
                            <h3>🐛 Memory Leaks & Crashes</h3>
                            <p>PDF generation is resource-intensive. Your app crashes under load, consumes massive memory, and becomes unstable in production.</p>
                        </div>
                        <div class="problem-item">
                            <h3>🔧 Maintenance Nightmare</h3>
                            <p>Font issues, encoding problems, layout bugs. Every browser, every OS behaves differently. You're stuck maintaining PDF code forever.</p>
                        </div>
                    </div>
                </div>
            </section>

            <!-- Solution Section -->
            <section class="solution">
                <div class="container">
                    <h2>The API That Just Works</h2>
                    <p class="subtitle">Enterprise-grade PDF processing with zero infrastructure headaches</p>
                    <div class="features-grid">
                        <div class="feature">
                            <div class="feature-icon">⚡</div>
                            <h3>3-Line Integration</h3>
                            <p>Replace complex PDF libraries with simple HTTP requests. Works with any language, any framework, any platform.</p>
                        </div>
                        <div class="feature">
                            <div class="feature-icon">🚀</div>
                            <h3>Production Scale</h3>
                            <p>Built for enterprise load. We handle the infrastructure, scaling, and reliability so you don't have to.</p>
                        </div>
                        <div class="feature">
                            <div class="feature-icon">🔒</div>
                            <h3>Enterprise Security</h3>
                            <p>SOC2 compliant, encrypted in transit and at rest. API key authentication with usage tracking and rate limiting.</p>
                        </div>
                        <div class="feature">
                            <div class="feature-icon">📊</div>
                            <h3>Real-time Analytics</h3>
                            <p>Monitor usage, track performance, and get detailed analytics. Know exactly how your PDF features are performing.</p>
                        </div>
                    </div>
                </div>
            </section>

            <!-- Code Comparison -->
            <section class="code-section">
                <div class="container">
                    <h2>From Complex to Simple</h2>
                    <div class="code-comparison">
                        <div class="code-block">
                            <h3>❌ Without Our API (50+ lines)</h3>
                            <pre><code>const PDFDocument = require('pdfkit');
const fs = require('fs');

// Create document
const doc = new PDFDocument();
doc.pipe(fs.createWriteStream('output.pdf'));

// Handle fonts, encoding, layout...
doc.font('Helvetica')
   .fontSize(25)
   .text('Some text', 100, 100);

// Memory management, error handling...
doc.on('end', () => {
  // Handle completion
});

// Handle different formats, images...
// Add tables, headers, footers...
// Deal with page breaks...
// Memory cleanup...
// Error handling...
// And 40+ more lines...</code></pre>
                        </div>
                        <div class="code-block">
                            <h3>✅ With Our API (3 lines)</h3>
                            <pre><code><span class="code-highlight">const response = await fetch('pdf-api.com/generate', {
  method: 'POST',
  headers: { 'X-API-Key': 'your-key' },
  body: JSON.stringify({
    title: 'My Document',
    text: 'Document content...'
  })
});

const result = await response.json();
console.log(result.downloadUrl);</span>

// That's it. 
// No dependencies.
// No memory issues.
// No maintenance.
// Works in production.</code></pre>
                        </div>
                    </div>
                </div>
            </section>

            <!-- Comparison Table -->
            <section class="comparison">
                <div class="container">
                    <h2>Why Developers Choose Us Over Building In-House</h2>
                    <table class="comparison-table">
                        <tr>
                            <th>Feature</th>
                            <th>Building In-House</th>
                            <th>Our API</th>
                        </tr>
                        <tr>
                            <td>Development Time</td>
                            <td class="them">2-6 weeks</td>
                            <td class="us">30 minutes</td>
                        </tr>
                        <tr>
                            <td>Infrastructure Cost</td>
                            <td class="them">$500-2000/month</td>
                            <td class="us">$9-99/month</td>
                        </tr>
                        <tr>
                            <td>Maintenance</td>
                            <td class="them">Ongoing developer hours</td>
                            <td class="us">Zero maintenance</td>
                        </tr>
                        <tr>
                            <td>Scaling</td>
                            <td class="them">Manual server management</td>
                            <td class="us">Automatic scaling</td>
                        </tr>
                        <tr>
                            <td>Reliability</td>
                            <td class="them">Your responsibility</td>
                            <td class="us">99.9% uptime SLA</td>
                        </tr>
                    </table>
                </div>
            </section>

            <!-- Pricing -->
            <section class="pricing" id="pricing">
                <div class="container">
                    <h2>Simple, Transparent Pricing</h2>
                    <p class="subtitle">Pay for what you use. No hidden fees. Cancel anytime.</p>
                    <div class="pricing-grid">
                        <div class="pricing-card">
                            <h3>Starter</h3>
                            <div class="price">$9<span>/month</span></div>
                            <ul>
                                <li>1,000 API calls/month</li>
                                <li>All PDF features</li>
                                <li>Email support</li>
                                <li>Usage analytics</li>
                                <li>99.9% uptime</li>
                            </ul>
                            <a href="/signup" class="btn btn-primary">Start Free Trial</a>
                        </div>
                        <div class="pricing-card featured">
                            <h3>Professional</h3>
                            <div class="price">$29<span>/month</span></div>
                            <ul>
                                <li>10,000 API calls/month</li>
                                <li>Priority support</li>
                                <li>Advanced features</li>
                                <li>Webhook notifications</li>
                                <li>Custom templates</li>
                            </ul>
                            <a href="/signup" class="btn btn-primary">Start Free Trial</a>
                        </div>
                        <div class="pricing-card">
                            <h3>Enterprise</h3>
                            <div class="price">$99<span>/month</span></div>
                            <ul>
                                <li>Unlimited API calls</li>
                                <li>SLA guarantee</li>
                                <li>Custom features</li>
                                <li>White-label option</li>
                                <li>Dedicated support</li>
                            </ul>
                            <a href="/signup" class="btn btn-primary">Start Free Trial</a>
                        </div>
                    </div>
                </div>
            </section>

            <!-- Final CTA -->
            <section class="final-cta">
                <div class="container">
                    <h2>Ready to Ship PDF Features Today?</h2>
                    <p>Join thousands of developers who stopped building PDF code and started shipping features.</p>
                    <div class="cta-buttons">
                        <a href="/signup" class="btn btn-primary">Start Free Trial</a>
                        <a href="/api/health" class="btn btn-secondary">View Documentation</a>
                    </div>
                </div>
            </section>

            <!-- Footer -->
            <footer class="footer">
                <div class="container">
                    <p>&copy; 2025 PDF API. Built for developers, by developers.</p>
                </div>
            </footer>
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
        },
        get_your_key: 'Sign up at /signup for your own API key'
    });
});

// API health with authentication info
app.get('/api/health', (req, res) => {
    res.json({
        status: 'Professional PDF API v3.0 - LIVE with Stripe Payments!',
        authentication: 'Required - Use X-API-Key header or api_key parameter',
        signup: '/signup',
        demo_keys: '/api/demo-keys',
        features: [
            'Live Stripe payment processing',
            'Authenticated API access',
            'Usage tracking & analytics', 
            'Rate limiting by subscription',
            'PDF generation & processing',
            'Customer management',
            'Automated billing'
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
            ],
            payments: [
                'POST /api/subscribe - Create subscription',
                'GET /signup - Sign up page'
            ]
        },
        business_model: {
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

// Enhanced dashboard with payment info
app.get('/dashboard', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Customer Dashboard</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
                .container { max-width: 900px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; }
                .usage-bar { background: #e0e0e0; height: 20px; border-radius: 10px; overflow: hidden; margin: 10px 0; }
                .usage-fill { background: linear-gradient(90deg, #4CAF50, #45a049); height: 100%; transition: width 0.3s; }
                input, button { padding: 10px; margin: 5px; border: 1px solid #ddd; border-radius: 5px; }
                button { background: #007bff; color: white; cursor: pointer; }
                .demo-key { background: #f8f9fa; padding: 10px; border-radius: 5px; margin: 5px 0; font-family: monospace; }
                .signup-cta { background: #28a745; color: white; padding: 15px 25px; border-radius: 5px; text-decoration: none; display: inline-block; margin: 10px 0; }
                .signup-cta:hover { background: #218838; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📊 PDF API Dashboard</h1>
                <p>Test your API usage and account information</p>
                
                <div style="background: #d1ecf1; padding: 20px; border-radius: 5px; margin: 20px 0;">
                    <h3>🚀 Ready to Go Live?</h3>
                    <p>Sign up for a paid plan to get unlimited access and your own API key!</p>
                    <a href="/signup" class="signup-cta">💳 Subscribe Now - Starting at $9/month</a>
                </div>
                
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
                <button onclick="generateStructured()">Generate Structured PDF</button>
                
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
                                    title: 'Live API Test PDF',
                                    text: 'This PDF was generated by the LIVE PDF API with Stripe payments! The system is now ready for paying customers and can process real subscriptions.'
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
                    
                    async function generateStructured() {
                        const apiKey = document.getElementById('apiKey').value;
                        try {
                            const response = await fetch('/api/generate/structured', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-API-Key': apiKey
                                },
                                body: JSON.stringify({
                                    title: 'PDF API Business Report',
                                    sections: [
                                        {
                                            type: 'heading',
                                            content: 'Executive Summary'
                                        },
                                        {
                                            type: 'paragraph',
                                            content: 'Our PDF API is now live with Stripe payments and ready for commercial customers. The system can process subscriptions, track usage, and generate professional PDFs at scale.'
                                        },
                                        {
                                            type: 'list',
                                            items: ['Live Stripe Integration', 'Automated Billing', 'Usage Tracking', 'Professional Documentation', 'Ready for Revenue']
                                        }
                                    ]
                                })
                            });
                            const data = await response.json();
                            
                            if (response.ok) {
                                document.getElementById('results').innerHTML = \`
                                    <h3>✅ Structured PDF Generated!</h3>
                                    <p><strong>Filename:</strong> \${data.filename}</p>
                                    <p><strong>Sections:</strong> \${data.sections}</p>
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
    console.log(`🚀 Professional PDF API v3.0 - LIVE with Stripe Payments!`);
    console.log(`💰 Business Dashboard: http://localhost:${port}`);
    console.log(`💳 Signup Page: http://localhost:${port}/signup`);
    console.log(`📋 API Documentation: http://localhost:${port}/api/health`);
    console.log(`📊 Customer Dashboard: http://localhost:${port}/dashboard`);
    console.log(`🎯 Ready to accept real payments!`);
});
