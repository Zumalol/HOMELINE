require('dotenv').config();

const express = require('express');
const ExcelJS = require('exceljs');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});
/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

// สำคัญมาก:
// เพิ่ม limit เพราะรูปภาพ Base64 มีขนาดใหญ่กว่า JSON ปกติ
app.use(express.json({ 
    limit: '50mb',
    verify: (req, res, buf) => {
        req.rawBody = buf; 
    }
}));
app.use(express.urlencoded({
    extended: true,
    limit: '50mb'
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));


/*
|--------------------------------------------------------------------------
| PostgreSQL Connection
|--------------------------------------------------------------------------
*/

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
    rejectUnauthorized: false 
  }
});

// ตรวจสอบ Database
pool.connect()
    .then(async client => {
        console.log('✅ เชื่อมต่อฐานข้อมูล PostgreSQL สำเร็จ');
        await client.query(`
            CREATE TABLE IF NOT EXISTS payment_accounts (
                id SERIAL PRIMARY KEY,
                bank_name VARCHAR(100),
                account_number VARCHAR(100),
                account_name VARCHAR(255),
                phone VARCHAR(50),
                qr_image TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS bills (
                id SERIAL PRIMARY KEY,
                room_number VARCHAR(50) NOT NULL,
                bill_url TEXT NOT NULL,
                public_id VARCHAR(255),
                status VARCHAR(50) DEFAULT 'ค้างชำระ',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS line_friends (
                user_id VARCHAR(100) PRIMARY KEY,
                display_name VARCHAR(255)
            );
            CREATE TABLE IF NOT EXISTS dormitories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cards (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                image_data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- เพิ่มคอลัมน์เก็บข้อมูลบิลประจำบิลแต่ละใบ
            ALTER TABLE bills ADD COLUMN IF NOT EXISTS bill_data TEXT;

            -- เพิ่มคอลัมน์สำหรับเก็บข้อมูลการเตรียมย้ายออกในตาราง rooms
            ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_moving_out BOOLEAN DEFAULT FALSE;
            ALTER TABLE rooms ADD COLUMN IF NOT EXISTS move_out_day VARCHAR(10);
            ALTER TABLE rooms ADD COLUMN IF NOT EXISTS move_out_month VARCHAR(50);
            ALTER TABLE rooms ADD COLUMN IF NOT EXISTS image_data TEXT;
            -- เพิ่มคอลัมน์ dormitory_id เชื่อมกับตาราง dormitories
            ALTER TABLE rooms ADD COLUMN IF NOT EXISTS dormitory_id INTEGER REFERENCES dormitories(id) ON DELETE SET NULL;

            -- เพิ่มคอลัมน์สำหรับเก็บสถานะการชำระเงิน
            ALTER TABLE rooms ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT '-';

            -- เพิ่มคอลัมน์สำหรับเก็บวันกำหนดชำระและค่าปรับต่อวันในตาราง rooms
            ALTER TABLE rooms ADD COLUMN IF NOT EXISTS bill_due_date DATE;
            ALTER TABLE rooms ADD COLUMN IF NOT EXISTS fine_per_day NUMERIC DEFAULT 0;
            
            -- เพิ่มคอลัมน์สำหรับเก็บข้อมูล Payload ของบิลเพื่อใช้อัปเดตค่าปรับย้อนหลัง
            ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_bill_data TEXT;
        `);
        client.release();
    })
    .catch(error => {
        console.error(
            '❌ เกิดข้อผิดพลาดในการเชื่อมต่อ PostgreSQL:',
            error.message
        );
    });


const apiPrefix = '/api';
/*
|--------------------------------------------------------------------------
| Dashboard API
|--------------------------------------------------------------------------
*/

app.get(`${apiPrefix}/dashboard`, async (req, res) => {

    try {

        // ดึงข้อมูลห้องพักพร้อมชื่อกลุ่มหอพัก
        const result = await pool.query(`
            SELECT r.*, d.name as dormitory_name 
            FROM rooms r
            LEFT JOIN dormitories d ON r.dormitory_id = d.id
        `);

        const rooms = result.rows;

        // ดึงรายการกลุ่มหอพักทั้งหมด
        const dormsResult = await pool.query(`SELECT * FROM dormitories ORDER BY id ASC`);
        const dormitories = dormsResult.rows;

        // สรุปภาพรวมรวมทั้งระบบ
        const totalRooms = rooms.length;
        const occupiedRooms = rooms.filter(room => room.status === 'Occupied').length;
        const bookedRooms = rooms.filter(room => room.status === 'Booked').length; 
        const vacantRooms = totalRooms - occupiedRooms - bookedRooms; 
        const totalRevenue = rooms
            .filter(room => room.status === 'Occupied')
            .reduce((sum, room) => sum + Number(room.price || 0), 0);

        // คำนวณสถิติแยกตามกลุ่มหอพักแต่ละแห่ง
        const dormStats = dormitories.map(dorm => {
            const dormRooms = rooms.filter(r => r.dormitory_id === dorm.id);
            const dTotal = dormRooms.length;
            const dOccupied = dormRooms.filter(r => r.status === 'Occupied').length;
            const dBooked = dormRooms.filter(r => r.status === 'Booked').length;
            const dVacant = dTotal - dOccupied - dBooked;
            const dRevenue = dormRooms
                .filter(r => r.status === 'Occupied')
                .reduce((sum, r) => sum + Number(r.price || 0), 0);

            return {
                id: dorm.id,
                name: dorm.name,
                totalRooms: dTotal,
                occupiedRooms: dOccupied,
                vacantRooms: dVacant,
                revenue: dRevenue
            };
        });

        // กรณีมีห้องที่ยังไม่ได้ผูกกลุ่มหอพัก
        const unassignedRooms = rooms.filter(r => !r.dormitory_id);
        if (unassignedRooms.length > 0) {
            const uTotal = unassignedRooms.length;
            const uOccupied = unassignedRooms.filter(r => r.status === 'Occupied').length;
            const uVacant = uTotal - uOccupied;
            const uRevenue = unassignedRooms
                .filter(r => r.status === 'Occupied')
                .reduce((sum, r) => sum + Number(r.price || 0), 0);

            dormStats.push({
                id: 'unassigned',
                name: 'ไม่ระบุกลุ่มหอพัก',
                totalRooms: uTotal,
                occupiedRooms: uOccupied,
                vacantRooms: uVacant,
                revenue: uRevenue
            });
        }

        res.json({
            success: true,
            totalRooms,
            occupiedRooms,
            vacantRooms,
            totalRevenue,
            dormStats
        });

    } catch (error) {

        console.error('Dashboard Error:', error);

        res.status(500).json({
            success: false,
            error: 'Database error'
        });
    }

});

/*
|--------------------------------------------------------------------------
| Dashboard
|--------------------------------------------------------------------------
*/

// 2. อัปเดต API Dashboard (/api/dashboard)
app.get(`${apiPrefix}/dashboard`, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.*, d.name as dormitory_name 
            FROM rooms r
            LEFT JOIN dormitories d ON r.dormitory_id = d.id
        `);
        const rooms = result.rows;

        const dormsResult = await pool.query(`SELECT * FROM dormitories ORDER BY id ASC`);
        const dormitories = dormsResult.rows;

        const totalRooms = rooms.length;
        const occupiedRooms = rooms.filter(room => room.status === 'Occupied').length;
        const bookedRooms = rooms.filter(room => room.status === 'Booked').length; 
        const movingOutRooms = rooms.filter(room => room.is_moving_out === true).length; // 🟢 เพิ่มนับจำนวนห้องเตรียมย้ายออก
        const vacantRooms = totalRooms - occupiedRooms - bookedRooms; 
        const totalRevenue = rooms
            .filter(room => room.status === 'Occupied')
            .reduce((sum, room) => sum + Number(room.price || 0), 0);

        res.json({
            success: true,
            totalRooms,
            occupiedRooms,
            bookedRooms,
            movingOutRooms, // 🟢 ส่งค่าห้องเตรียมย้ายออกไปยัง Dashboard
            vacantRooms,
            totalRevenue
        });
    } catch (error) {
        console.error('Dashboard Error:', error);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// API สำหรับดึงรูปภาพของห้องพัก (รองรับการระบุ index รูปภาพ)
app.get(`${apiPrefix}/rooms/:id/image`, async (req, res) => {
    try {
        const { id } = req.params;
        const imgIndex = parseInt(req.query.index) || 0; // รับค่า index ของรูปภาพ (เริ่มต้นที่ 0)

        const result = await pool.query('SELECT image_data FROM rooms WHERE id = $1', [id]);
        
        if (result.rows.length === 0 || !result.rows[0].image_data) {
            return res.status(404).send('Image not found');
        }

        let rawData = result.rows[0].image_data;
        let imagesList = [];

        // แปลงข้อมูลรูปภาพกรณีเก็บเป็น JSON Array หรือ String
        try {
            const parsed = JSON.parse(rawData);
            if (Array.isArray(parsed)) {
                imagesList = parsed;
            } else if (typeof parsed === 'string') {
                imagesList = [parsed];
            }
        } catch (e) {
            imagesList = [rawData];
        }

        if (imagesList.length === 0) {
            return res.status(404).send('Image not found');
        }

        // เลือกรูปตาม index ที่ส่งมา (ถ้าเกินขอบเขตให้ใช้รูปแรก)
        let imageData = imagesList[imgIndex] || imagesList[0];

        // กรณีข้อมูลรูปภาพเป็น Base64
        if (imageData.startsWith('data:image/')) {
            const matches = imageData.match(/^data:(image\/\w+);base64,(.+)$/);
            if (matches) {
                const contentType = matches[1];
                const buffer = Buffer.from(matches[2], 'base64');
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Content-Length': buffer.length,
                    'Cache-Control': 'public, max-age=86400'
                });
                return res.end(buffer);
            }
        } 
        // กรณีข้อมูลรูปภาพเป็น URL อยู่แล้ว
        else if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
            return res.redirect(imageData.replace('http://', 'https://'));
        }

        res.status(400).send('Invalid image format');
    } catch (error) {
        console.error('Room Image Serve Error:', error);
        res.status(500).send('Server error');
    }
});

/*
|--------------------------------------------------------------------------
| TENANTS TABLE & REST API
|--------------------------------------------------------------------------
*/

// ดึงรายชื่อผู้เช่าทั้งหมดจากตาราง tenants ในฐานข้อมูล PostgreSQL
app.get('/api/tenants', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, l.display_name 
            FROM tenants t 
            LEFT JOIN line_friends l ON t.line_id = l.user_id 
            ORDER BY t.id DESC
        `);
        res.json({ success: true, tenants: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Database error', error: error.message });
    }
});

/*
|--------------------------------------------------------------------------
| TENANTS TABLE & REST API
|--------------------------------------------------------------------------
*/

// สร้างตาราง tenants อัตโนมัติเมื่อเริ่ม Server
pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        id_card VARCHAR(50),
        phone VARCHAR(50),
        parent_phone VARCHAR(50),
        line_id VARCHAR(100),
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`).catch(err => console.error('Error creating tenants table:', err));

// ดึงรายชื่อผู้เช่าทั้งหมด
app.get(`${apiPrefix}/tenants`, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, l.display_name 
            FROM tenants t 
            LEFT JOIN line_friends l ON t.line_id = l.user_id 
            ORDER BY t.id DESC
        `);
        res.json({ success: true, tenants: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Database error', error: error.message });
    }
});

// เพิ่มผู้เช่าใหม่
app.post(`${apiPrefix}/tenants`, async (req, res) => {
    const { name, id_card, phone, parent_phone, line_id, address } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อและเบอร์โทรศัพท์' });
    }

    try {
        const result = await pool.query(`
            INSERT INTO tenants (name, id_card, phone, parent_phone, line_id, address)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [name, id_card, phone, parent_phone, line_id, address]);

        res.status(201).json({ success: true, message: 'เพิ่มผู้เช่าสำเร็จ!', tenant: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึก', error: error.message });
    }
});

// แก้ไขข้อมูลผู้เช่า
app.put(`${apiPrefix}/tenants/:id`, async (req, res) => {
    const { id } = req.params;
    const { name, id_card, phone, parent_phone, line_id, address } = req.body;

    try {
        const result = await pool.query(`
            UPDATE tenants
            SET name = $1, id_card = $2, phone = $3, parent_phone = $4, line_id = $5, address = $6
            WHERE id = $7
            RETURNING *
        `, [name, id_card, phone, parent_phone, line_id, address, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบผู้เช่าที่ต้องการแก้ไข' });
        }

        res.json({ success: true, message: 'แก้ไขข้อมูลผู้เช่าสำเร็จ!', tenant: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดต', error: error.message });
    }
});

// ลบผู้เช่า
app.delete(`${apiPrefix}/tenants/:id`, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM tenants WHERE id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้เช่า' });
        }

        res.json({ success: true, message: 'ลบข้อมูลผู้เช่าเรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบ', error: error.message });
    }
});
// =====================================================
// API: ข้อมูลบัญชีรับเงิน (Payment Accounts)
// =====================================================
// =====================================================
// API: ข้อมูลบัญชีรับเงิน (Payment Accounts)
// =====================================================
const getPaymentAccountsHandler = async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM payment_accounts ORDER BY id DESC');
        
        // แมปตัวแปรให้มีทั้ง snake_case, camelCase และ pay* Aliases
        const accounts = result.rows.map(acc => ({
            ...acc,
            bankName: acc.bank_name,
            accountNumber: acc.account_number,
            accountName: acc.account_name,
            payBank: acc.bank_name,
            payAccountNo: acc.account_number,
            payName: acc.account_name,
            payPhone: acc.phone,
            payQrBase64: acc.qr_image
        }));

        // ส่งทั้ง accounts และ data รองรับ Frontend ทุกรูปแบบ
        res.json({ 
            success: true, 
            accounts: accounts, 
            data: accounts 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// รองรับทั้ง /api/payment-accounts, /api/payment-account และ /api/bank-accounts
app.get(`${apiPrefix}/payment-accounts`, getPaymentAccountsHandler);
app.get(`${apiPrefix}/payment-account`, getPaymentAccountsHandler);
app.get(`${apiPrefix}/bank-accounts`, getPaymentAccountsHandler);

const postPaymentAccountHandler = async (req, res) => {
    const bank_name = req.body.bank_name || req.body.bankName || req.body.payBank || req.body.bank;
    const account_number = req.body.account_number || req.body.accountNumber || req.body.payAccountNo || req.body.accountNo;
    const account_name = req.body.account_name || req.body.accountName || req.body.payName || req.body.account;
    const phone = req.body.phone || req.body.payPhone || '';
    const qr_image = req.body.qr_image || req.body.qrImage || req.body.payQrBase64 || req.body.qrCode || req.body.qr_code || null;

    if (!bank_name || !account_number) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อธนาคารและเลขที่บัญชี' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO payment_accounts (bank_name, account_number, account_name, phone, qr_image) 
             VALUES ($1, $2, $3, $4, $5) 
             RETURNING *`,
            [bank_name, account_number, account_name, phone, qr_image]
        );
        const acc = result.rows[0];
        const formattedAcc = {
            ...acc,
            bankName: acc.bank_name,
            accountNumber: acc.account_number,
            accountName: acc.account_name,
            payBank: acc.bank_name,
            payAccountNo: acc.account_number,
            payName: acc.account_name,
            payPhone: acc.phone,
            payQrBase64: acc.qr_image
        };
        res.json({ success: true, message: 'บันทึกบัญชีรับเงินสำเร็จ', account: formattedAcc, data: formattedAcc });
    } catch (error) {
        console.error('Save Payment Account Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

app.post(`${apiPrefix}/payment-accounts`, postPaymentAccountHandler);
app.post(`${apiPrefix}/payment-account`, postPaymentAccountHandler);
app.post(`${apiPrefix}/bank-accounts`, postPaymentAccountHandler);

// แก้ไขข้อมูลบัญชีรับเงิน (PUT)
app.put(`${apiPrefix}/payment-accounts/:id`, async (req, res) => {
    const { id } = req.params;
    const bank_name = req.body.bank_name || req.body.bankName || req.body.payBank || req.body.bank;
    const account_number = req.body.account_number || req.body.accountNumber || req.body.payAccountNo || req.body.accountNo;
    const account_name = req.body.account_name || req.body.accountName || req.body.payName || req.body.account;
    const phone = req.body.phone || req.body.payPhone || '';
    const qr_image = req.body.qr_image || req.body.qrImage || req.body.payQrBase64 || req.body.qrCode || req.body.qr_code || null;

    try {
        const result = await pool.query(
            `UPDATE payment_accounts 
             SET bank_name = COALESCE($1, bank_name), 
                 account_number = COALESCE($2, account_number), 
                 account_name = COALESCE($3, account_name), 
                 phone = COALESCE($4, phone), 
                 qr_image = COALESCE($5, qr_image)
             WHERE id = $6 RETURNING *`,
            [bank_name, account_number, account_name, phone, qr_image, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบบัญชีที่ต้องการแก้ไข' });
        }

        res.json({ success: true, message: 'แก้ไขบัญชีรับเงินสำเร็จ', account: result.rows[0] });
    } catch (error) {
        console.error('Update Payment Account Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete(`${apiPrefix}/payment-accounts/:id`, async (req, res) => {
    try {
        await pool.query('DELETE FROM payment_accounts WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'ลบบัญชีเรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API สตรีมรูป QR Code ให้ LINE ดึงไปแสดงผล
app.get(`${apiPrefix}/payment-accounts/:id/qr`, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT qr_image FROM payment_accounts WHERE id = $1', [id]);
        if (result.rows.length > 0 && result.rows[0].qr_image) {
            const qrData = result.rows[0].qr_image;
            const matches = qrData.match(/^data:(image\/\w+);base64,(.+)$/);
            if (matches) {
                const buffer = Buffer.from(matches[2], 'base64');
                res.writeHead(200, { 'Content-Type': matches[1], 'Content-Length': buffer.length });
                return res.end(buffer);
            } else if (qrData.startsWith('http')) {
                return res.redirect(qrData);
            }
        }
        res.status(404).send('QR Not found');
    } catch (error) {
        res.status(500).send('Error');
    }
});

/*
|--------------------------------------------------------------------------
| LINE Webhook (เก็บรายชื่อคนที่เป็นเพื่อน)
|--------------------------------------------------------------------------
*/

const pendingSlipBills = new Map();

app.post('/webhook', async (req, res) => {
    const signature = req.headers['x-line-signature'];
    
    
    if (!req.rawBody) {
        return res.status(400).send('No raw body');
    }

    const hash = crypto.createHmac('SHA256', process.env.LINE_CHANNEL_SECRET)
                       .update(req.rawBody)
                       .digest('base64');

    if (hash !== signature) {
        return res.status(401).send('Unauthorized');
    }

    try {
        const events = req.body.events;
        if (!events) return res.status(200).send('OK');

        for (const event of events) {
            // 1. ดักจับเมื่อมีคนเพิ่มเพื่อน หรือพิมพ์ข้อความ
            if (event.type === 'follow' || (event.type === 'message' && event.message.type === 'text')) {
                const userId = event.source.userId;
                const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
                    headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
                });
                
                if (profileRes.ok) {
                    const profile = await profileRes.json();
                    await pool.query(`
                        INSERT INTO line_friends (user_id, display_name) 
                        VALUES ($1, $2)
                        ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name
                    `, [userId, profile.displayName]);
                }
            }
            // 🟢 ดักจับคำว่า "ตรวจสอบห้องว่าง" และส่งการ์ดรายชื่อห้องว่างกลับไป
            if (event.type === 'message' && event.message.text === 'ตรวจสอบห้องว่าง') {
                // ดึงข้อมูลห้องพักที่ "ว่าง" (สถานะไม่ใช่ Occupied และ Booked) 
                // พร้อม join ชื่อกลุ่มหอพัก (จำกัด 10 ห้อง เพื่อไม่ให้เกินโควตา Carousel ของ LINE)
                const roomsResult = await pool.query(`
                    SELECT r.*, d.name as dormitory_name 
                    FROM rooms r
                    LEFT JOIN dormitories d ON r.dormitory_id = d.id
                    WHERE r.status IS DISTINCT FROM 'Occupied' 
                    AND r.status IS DISTINCT FROM 'Booked'
                    ORDER BY r.number ASC 
                    LIMIT 10
                `);
                
                if (roomsResult.rows.length > 0) {
                    const flexContents = roomsResult.rows.map(room => {
                        let bubble = {
                            type: "bubble",
                            size: "mega",
                            header: {
                                type: "box",
                                layout: "vertical",
                                backgroundColor: "#4f46e5", // ตกแต่งหัวการ์ดด้วยสี Indigo 
                                paddingAll: "xl",
                                contents: [
                                    { type: "text", text: `ห้อง ${room.number}`, color: "#ffffff", weight: "bold", size: "xl" },
                                    { type: "text", text: room.dormitory_name || "ไม่ระบุหอพัก", color: "#e0e7ff", size: "sm", margin: "sm" }
                                ]
                            },
                            body: {
                                type: "box",
                                layout: "vertical",
                                spacing: "md",
                                paddingAll: "xl",
                                contents: [
                                    {
                                        type: "box",
                                        layout: "baseline",
                                        contents: [
                                            { type: "text", text: "ประเภท", color: "#888888", size: "sm", flex: 1 },
                                            { type: "text", text: room.type || "Standard", color: "#333333", size: "sm", flex: 2, align: "end", weight: "bold" }
                                        ]
                                    },
                                    {
                                        type: "box",
                                        layout: "baseline",
                                        contents: [
                                            { type: "text", text: "ราคา", color: "#888888", size: "sm", flex: 1 },
                                            { type: "text", text: `${Number(room.price || 0).toLocaleString()} ฿`, color: "#ef4444", size: "md", weight: "bold", flex: 2, align: "end" }
                                        ]
                                    }
                                ]
                            },
                            footer: {
                                type: "box",
                                layout: "vertical",
                                paddingAll: "xl",
                                contents: [
                                    {
                                        type: "button",
                                        style: "primary",
                                        color: "#4f46e5",
                                        action: {
                                            type: "message", // กดแล้วระบบจะพิมพ์ข้อความส่งกลับอัตโนมัติ
                                            label: "ดูรายละเอียด / สนใจห้องนี้",
                                            text: `สนใจรายละเอียดห้อง ${room.number}`
                                        }
                                    }
                                ]
                            }
                        };

                        // หากมีรูปภาพและเป็น URL จะนำมาแสดงเป็นรูปหน้าปกการ์ด
                        if (room.image_data && room.image_data.startsWith('http')) {
                            bubble.hero = {
                                type: "image",
                                url: room.image_data,
                                size: "full",
                                aspectRatio: "20:13",
                                aspectMode: "cover"
                            };
                        }
                        
                        return bubble;
                    });

                    // ส่งกลับเป็น Flex Message แบบ Carousel (หากมีหลายห้องจะปัดซ้ายขวาได้)
                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                        },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{
                                type: "flex",
                                altText: "รายการห้องว่าง",
                                contents: {
                                    type: "carousel",
                                    contents: flexContents
                                }
                            }]
                        })
                    });
                } else {
                    // กรณีไม่มีห้องว่างเลย
                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                        },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{ type: 'text', text: 'ขณะนี้ไม่มีห้องว่างเลยครับ หากมีห้องหลุดจองจะรีบแจ้งให้ทราบนะครับ 😊' }]
                        })
                    });
                }
            }
            // 🟢 ดักจับคำว่า "สนใจรายละเอียดห้อง ${room.number}" (เช่น "สนใจรายละเอียดห้อง 101")
            const roomDetailMatch = event.message && event.message.type === 'text' && event.message.text.match(/^สนใจรายละเอียดห้อง\s*(.+)$/);
            
            if (roomDetailMatch) {
                const roomNumber = roomDetailMatch[1].trim();

                const roomResult = await pool.query(`
                    SELECT r.*, d.name as dormitory_name 
                    FROM rooms r
                    LEFT JOIN dormitories d ON r.dormitory_id = d.id
                    WHERE r.number = $1
                `, [roomNumber]);

                if (roomResult.rows.length > 0) {
                    const room = roomResult.rows[0];

                    // ตรวจหาจำนวนรูปภาพทั้งหมดใน DB
                    let imageCount = 0;
                    if (room.image_data) {
                        try {
                            const parsed = JSON.parse(room.image_data);
                            imageCount = Array.isArray(parsed) ? parsed.length : 1;
                        } catch (e) {
                            imageCount = 1;
                        }
                    }

                    let statusText = '🟢 ห้องว่างพร้อมเข้าอยู่';
                    let statusColor = '#10b981';
                    if (room.status === 'Occupied') {
                        statusText = '🔴 มีผู้เช่าแล้ว';
                        statusColor = '#ef4444';
                    } else if (room.status === 'Booked') {
                        statusText = '🔵 ติดจอง';
                        statusColor = '#3b82f6';
                    }

                    const flexContents = {
                        type: "bubble",
                        size: "mega",
                        header: {
                            type: "box",
                            layout: "vertical",
                            backgroundColor: "#4f46e5",
                            paddingAll: "xl",
                            contents: [
                                { type: "text", text: `🏢 รายละเอียดห้อง ${room.number}`, color: "#ffffff", weight: "bold", size: "xl" },
                                { type: "text", text: room.dormitory_name || "ไม่ระบุหอพัก", color: "#c7d2fe", size: "sm", margin: "xs" }
                            ]
                        },
                        body: {
                            type: "box",
                            layout: "vertical",
                            spacing: "md",
                            paddingAll: "xl",
                            contents: [
                                {
                                    type: "box",
                                    layout: "baseline",
                                    contents: [
                                        { type: "text", text: "ราคาเช่า", color: "#6b7280", size: "sm", flex: 1 },
                                        { type: "text", text: `${Number(room.price || 0).toLocaleString()} ฿ / เดือน`, color: "#4f46e5", size: "lg", weight: "bold", flex: 2, align: "end" }
                                    ]
                                },
                                {
                                    type: "box",
                                    layout: "baseline",
                                    contents: [
                                        { type: "text", text: "ประเภทห้อง", color: "#6b7280", size: "sm", flex: 1 },
                                        { type: "text", text: room.type || "Standard", color: "#1f2937", size: "sm", weight: "bold", flex: 2, align: "end" }
                                    ]
                                },
                                {
                                    type: "box",
                                    layout: "baseline",
                                    contents: [
                                        { type: "text", text: "สถานะ", color: "#6b7280", size: "sm", flex: 1 },
                                        { type: "text", text: statusText, color: statusColor, size: "sm", weight: "bold", flex: 2, align: "end" }
                                    ]
                                }
                            ]
                        },
                        footer: {
                            type: "box",
                            layout: "vertical",
                            spacing: "sm",
                            paddingAll: "xl",
                            contents: []
                        }
                    };

                    // ถ้ามีรูปภาพ ให้เพิ่มปุ่ม "ดูรูปภาพทั้งหมด"
                    if (imageCount > 0) {
                        flexContents.footer.contents.push({
                            type: "button",
                            style: "secondary",
                            color: "#4f46e5",
                            action: {
                                type: "message",
                                label: `📸 ดูรูปภาพทั้งหมด (${imageCount} รูป)`,
                                text: `ดูรูปภาพห้อง ${room.number}`
                            }
                        });
                    }

                    // ปุ่มจองห้อง
                    flexContents.footer.contents.push({
                        type: "button",
                        style: "primary",
                        color: "#4f46e5",
                        action: {
                            type: "message",
                            label: "สนใจจองห้องนี้ / ติดต่อแอดมิน",
                            text: `ต้องการจองห้อง ${room.number}`
                        }
                    });

                    // รูปหน้าปก
                    if (room.image_data) {
                        const host = req.get('host');
                        flexContents.hero = {
                            type: "image",
                            url: `https://${host}${apiPrefix}/rooms/${room.id}/image?index=0`,
                            size: "full",
                            aspectRatio: "16:9",
                            aspectMode: "cover"
                        };
                    }

                    if (room.is_moving_out) {
                        flexContents.body.contents.push({
                            type: "box",
                            layout: "horizontal",
                            backgroundColor: "#fff7ed",
                            paddingAll: "md",
                            cornerRadius: "md",
                            margin: "md",
                            contents: [
                                {
                                    type: "text",
                                    text: `📦 คาดว่าจะว่างประมาณ: ${room.move_out_day || ''} ${room.move_out_month || ''}`,
                                    color: "#c2410c",
                                    size: "xs",
                                    weight: "bold",
                                    wrap: true
                                }
                            ]
                        });
                    }

                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                        },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{
                                type: "flex",
                                altText: `รายละเอียดห้อง ${room.number}`,
                                contents: flexContents
                            }]
                        })
                    });
                }
            }

            // 🟢 ดักจับคำว่า "ดูรูปภาพห้อง ${room.number}" (เมื่อกดปุ่มดูรูปภาพทั้งหมด)
            const roomPhotosMatch = event.message && event.message.type === 'text' && event.message.text.match(/^ดูรูปภาพห้อง\s*(.+)$/);

            if (roomPhotosMatch) {
                const roomNumber = roomPhotosMatch[1].trim();

                const roomResult = await pool.query('SELECT * FROM rooms WHERE number = $1', [roomNumber]);

                if (roomResult.rows.length > 0 && roomResult.rows[0].image_data) {
                    const room = roomResult.rows[0];
                    let imagesList = [];

                    try {
                        const parsed = JSON.parse(room.image_data);
                        if (Array.isArray(parsed)) imagesList = parsed;
                        else imagesList = [parsed];
                    } catch (e) {
                        imagesList = [room.image_data];
                    }

                    const host = req.get('host');
                    
                    // สร้างสไลด์การ์ด (Carousel) ตามจำนวนรูปภาพที่มี
                    const carouselContents = imagesList.map((_, idx) => {
                        const imageUrl = `https://${host}${apiPrefix}/rooms/${room.id}/image?index=${idx}`;
                        return {
                            type: "bubble",
                            size: "mega",
                            hero: {
                                type: "image",
                                url: imageUrl,
                                size: "full",
                                aspectRatio: "4:3",
                                aspectMode: "cover",
                                action: {
                                    type: "uri",
                                    label: "ดูรูปขนาดเต็ม",
                                    uri: imageUrl
                                }
                            },
                            body: {
                                type: "box",
                                layout: "vertical",
                                paddingAll: "md",
                                contents: [
                                    {
                                        type: "text",
                                        text: `🖼️ รูปที่ ${idx + 1}/${imagesList.length} - ห้อง ${room.number}`,
                                        weight: "bold",
                                        size: "sm",
                                        color: "#374151",
                                        align: "center"
                                    }
                                ]
                            }
                        };
                    });

                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                        },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{
                                type: "flex",
                                altText: `อัลบั้มรูปภาพห้อง ${room.number}`,
                                contents: {
                                    type: "carousel",
                                    contents: carouselContents
                                }
                            }]
                        })
                    });
                } else {
                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                        },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{ type: 'text', text: `❌ ไม่พบรูปภาพของห้อง ${roomNumber} ในระบบครับ` }]
                        })
                    });
                }
            }
            
           
            // 🟢 ดักจับคำว่า "ตรวจสอบบิลค้างชำระ"
            if (event.type === 'message' && event.message.type === 'text' && event.message.text === 'ตรวจสอบบิลค้างชำระ') {
                const userId = event.source.userId;

                try {
                    const roomRes = await pool.query(`
                        SELECT r.* 
                        FROM rooms r
                        JOIN tenants t ON r.tenant = t.name
                        WHERE t.line_id = $1
                    `, [userId]);

                    if (roomRes.rows.length === 0) {
                        await fetch('https://api.line.me/v2/bot/message/reply', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                            },
                            body: JSON.stringify({
                                replyToken: event.replyToken,
                                messages: [{ type: 'text', text: '❌ ไม่พบข้อมูลห้องพักที่ผูกกับบัญชี LINE ของคุณครับ กรุณาติดต่อแอดมิน' }]
                            })
                        });
                        return;
                    }

                    const room = roomRes.rows[0];

                    // ดึงบิลค้างชำระจาก PostgreSQL แทนการอ่านจากโฟลเดอร์ local
                    const billsRes = await pool.query(`
                        SELECT * FROM bills 
                        WHERE room_number = $1 AND status = 'ค้างชำระ' 
                        ORDER BY id DESC
                    `, [room.number]);

                    const unPaidBills = billsRes.rows;

                    if (unPaidBills.length === 0) {
                        await fetch('https://api.line.me/v2/bot/message/reply', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                            },
                            body: JSON.stringify({
                                replyToken: event.replyToken,
                                messages: [{ type: 'text', text: `✅ ห้อง ${room.number} ของคุณไม่มีบิลค้างชำระในระบบครับ` }]
                            })
                        });
                        return;
                    }

                    const flexContents = unPaidBills.map(bill => ({
                        type: "bubble",
                        size: "mega",
                        header: {
                            type: "box",
                            layout: "vertical",
                            backgroundColor: "#ef4444",
                            paddingAll: "lg",
                            contents: [
                                { type: "text", text: `⚠️ บิลค้างชำระ ห้อง ${room.number}`, color: "#ffffff", weight: "bold", size: "lg" }
                            ]
                        },
                        hero: {
                            type: "image",
                            url: bill.bill_url,
                            size: "full",
                            aspectRatio: "3:4",
                            aspectMode: "fit",
                            backgroundColor: "#f9fafb",
                            action: { type: "uri", label: "ดูรูปบิลขนาดเต็ม", uri: bill.bill_url }
                        },
                        body: {
                            type: "box",
                            layout: "vertical",
                            paddingAll: "md",
                            contents: [
                                { type: "text", text: "สถานะ: ⏳ ค้างชำระ", color: "#ef4444", weight: "bold", size: "md", align: "center" },
                                {type: "box", layout: "vertical", paddingAll: "sm",
                                contents: [{
                                    type: "button", style: "primary", color: "#3b82f6",
                                    action: { type: "message", label: "เลือกชำระบิลนี้", text: `แจ้งชำระบิล #${bill.id}` }
                                }]
                            }
                            ]
                        }
                    }));

                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                        },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{
                                type: "flex",
                                altText: `รายการบิลค้างชำระ ห้อง ${room.number}`,
                                contents: { type: "carousel", contents: flexContents }
                            }]
                        })
                    });

                } catch (error) {
                    console.error('Check Bills Error:', error);
                }
            }
            // 🟢 ดักจับคำว่า "ชำระเงินทั้งหมด"
            if (event.type === 'message' && event.message.type === 'text' && event.message.text === 'ชำระเงินทั้งหมด') {
                const userId = event.source.userId;

                try {
                    // ค้นหาห้องจาก line_id
                    const roomRes = await pool.query(`
                        SELECT r.* 
                        FROM rooms r
                        JOIN tenants t ON r.tenant = t.name
                        WHERE t.line_id = $1
                    `, [userId]);

                    if (roomRes.rows.length === 0) {
                        await fetch('https://api.line.me/v2/bot/message/reply', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
                            body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: 'text', text: '❌ ไม่พบข้อมูลห้องพักที่ผูกกับบัญชี LINE ของคุณครับ' }] })
                        });
                        return;
                    }

                    const room = roomRes.rows[0];

                    // ดึงบิลค้างชำระจาก PostgreSQL ตาราง bills
                    const billsRes = await pool.query(`
                        SELECT * FROM bills 
                        WHERE room_number = $1 AND status = 'ค้างชำระ' 
                        ORDER BY id DESC
                    `, [room.number]);

                    const unPaidBills = billsRes.rows;

                    if (unPaidBills.length === 0) {
                        await fetch('https://api.line.me/v2/bot/message/reply', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
                            body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: 'text', text: `✅ ห้อง ${room.number} ของคุณไม่มีบิลค้างชำระในระบบครับ` }] })
                        });
                        return;
                    }

                    const flexContents = unPaidBills.map(bill => {
                        return {
                            type: "bubble",
                            size: "mega",
                            header: {
                                type: "box", layout: "vertical", backgroundColor: "#3b82f6", paddingAll: "lg",
                                contents: [{ type: "text", text: `📄 บิลห้อง ${room.number} (#${bill.id})`, color: "#ffffff", weight: "bold", size: "lg" }]
                            },
                            hero: {
                                type: "image", url: bill.bill_url, size: "full", aspectRatio: "3:4", aspectMode: "fit", backgroundColor: "#f9fafb",
                                action: { type: "uri", label: "ดูรูปเต็ม", uri: bill.bill_url }
                            },
                            body: {
                                type: "box", layout: "vertical", paddingAll: "md",
                                contents: [{ type: "text", text: "สถานะ: ⏳ ค้างชำระ", color: "#ef4444", weight: "bold", align: "center", size: "md" }]
                            },
                            footer: {
                                type: "box", layout: "vertical", paddingAll: "sm",
                                contents: [{
                                    type: "button", style: "primary", color: "#3b82f6",
                                    action: { type: "message", label: "เลือกชำระบิลนี้", text: `แจ้งชำระบิล #${bill.id}` }
                                }]
                            }
                        };
                    });

                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{
                                type: "flex", altText: `รายการบิลค้างชำระ ห้อง ${room.number}`,
                                contents: { type: "carousel", contents: flexContents }
                            }]
                        })
                    });
                } catch (error) {
                    console.error('Pay All Bills Error:', error);
                }
            }

            // 🟢 ดักจับข้อความเมื่อผู้เช่ากดปุ่ม "เลือกชำระบิลนี้"
            const payBillMatch = event.message && event.message.type === 'text' && event.message.text.match(/^แจ้งชำระบิล\s*(.+)$/);
            if (payBillMatch) {
                const billName = payBillMatch[1].trim();
                pendingSlipBills.set(event.source.userId, billName); 
                
                let bankName = '-', accNo = '-', accName = '-';
                let qrUrl = null;

                try {
                    const billIdMatch = billName.match(/#(\d+)/);
                    if (billIdMatch) {
                        const billId = billIdMatch[1];
                        // 🟢 ดึง bill_data จากตาราง bills ของบิลใบนั้นโดยตรง
                        const billRes = await pool.query('SELECT room_number, bill_data FROM bills WHERE id = $1', [billId]);
                        
                        if (billRes.rows.length > 0) {
                            let billData = null;

                            if (billRes.rows[0].bill_data) {
                                billData = JSON.parse(billRes.rows[0].bill_data);
                            } else {
                                // Fallback: สำหรับบิลเก่าที่ยังไม่มี bill_data ให้ดึงจากตาราง rooms
                                const roomRes = await pool.query('SELECT last_bill_data FROM rooms WHERE number = $1', [billRes.rows[0].room_number]);
                                if (roomRes.rows.length > 0 && roomRes.rows[0].last_bill_data) {
                                    billData = JSON.parse(roomRes.rows[0].last_bill_data);
                                }
                            }

                            if (billData) {
                                bankName = billData.payBank || billData.bank_name || billData.bankName || '-';
                                accNo = billData.payAccountNo || billData.account_number || billData.accountNumber || '-';
                                accName = billData.payName || billData.account_name || billData.accountName || '-';

                                if (accNo !== '-') {
                                    const accRes = await pool.query('SELECT id, qr_image FROM payment_accounts WHERE account_number = $1 LIMIT 1', [accNo]);
                                    if (accRes.rows.length > 0 && accRes.rows[0].qr_image) {
                                        const host = req.get('host');
                                        qrUrl = `https://${host}${apiPrefix}/payment-accounts/${accRes.rows[0].id}/qr`;
                                    }
                                }
                            }
                        }
                    }

                    // 🟢 FALLBACK: ถ้าในข้อมูลบิลไม่มีรายละเอียดธนาคาร ให้ดึงบัญชีล่าสุดจากตาราง payment_accounts
                    if (bankName === '-' || accNo === '-') {
                        const defaultAccRes = await pool.query('SELECT * FROM payment_accounts ORDER BY id DESC LIMIT 1');
                        if (defaultAccRes.rows.length > 0) {
                            const acc = defaultAccRes.rows[0];
                            bankName = acc.bank_name || '-';
                            accNo = acc.account_number || '-';
                            accName = acc.account_name || '-';

                            if (acc.qr_image) {
                                const host = req.get('host');
                                qrUrl = `https://${host}${apiPrefix}/payment-accounts/${acc.id}/qr`;
                            }
                        }
                    }
                } catch (err) {
                    console.error('Fetch Bill Info Error:', err);
                }

                const flexBubble = {
                    type: "bubble",
                    body: {
                        type: "box", layout: "vertical", spacing: "md",
                        contents: [
                            { type: "text", text: "ช่องทางการชำระเงิน", weight: "bold", color: "#3b82f6", size: "sm" },
                            { type: "text", text: billName, weight: "bold", size: "xl", wrap: true },
                            { type: "separator", margin: "md" },
                            {
                                type: "box", layout: "vertical", spacing: "sm", margin: "md",
                                contents: [
                                    { type: "text", text: `🏦 ธนาคาร/พร้อมเพย์: ${bankName}`, size: "md", wrap: true },
                                    { type: "text", text: `💳 เลขบัญชี: ${accNo}`, size: "md", weight: "bold", color: "#111827" },
                                    { type: "text", text: `👤 ชื่อบัญชี: ${accName}`, size: "md", wrap: true }
                                ]
                            },
                            { type: "separator", margin: "lg" },
                            { 
                                type: "text", 
                                text: "หากโอนแล้วกรุณาส่งสลิป", 
                                weight: "bold", 
                                size: "xxl", 
                                color: "#ef4444", 
                                align: "center", 
                                margin: "xl", 
                                wrap: true 
                            }
                        ]
                    }
                };

                if (qrUrl) {
                    flexBubble.hero = {
                        type: "image", url: qrUrl, size: "full", aspectRatio: "1:1", aspectMode: "fit", backgroundColor: "#ffffff"
                    };
                }

                await fetch('https://api.line.me/v2/bot/message/reply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
                    body: JSON.stringify({
                        replyToken: event.replyToken,
                        messages: [{ type: "flex", altText: "ข้อมูลการชำระเงิน", contents: flexBubble }]
                    })
                });
            }
            

            // 2. ดักจับเมื่อผู้เช่า "ส่งรูปภาพสลิป" เข้ามาใน LINE
            if (event.type === 'message' && event.message.type === 'image') {
                const messageId = event.message.id;
                const pendingBill = pendingSlipBills.get(event.source.userId) || '';
                
                // ดึงรูปภาพจาก LINE API
                const imageRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
                    headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
                });
                
                if (imageRes.ok) {
                    const imageBuffer = await imageRes.arrayBuffer();
                    const formData = new FormData();
                    formData.append('files', new Blob([imageBuffer], { type: 'image/jpeg' }), 'slip.jpg');

                    // ส่งรูปไปตรวจที่ SlipOK
                    const slipRes = await fetch(`https://api.slipok.com/api/line/apikey/${process.env.SLIPOK_BRANCH_ID}`, {
                        method: 'POST',
                        headers: { 'x-authorization': process.env.SLIP_OK_API_KEY },
                        body: formData
                    });
                    const slipResult = await slipRes.json();

                    // เตรียมข้อความและดึงข้อมูลออกมาใน Scope ด้านนอก
                    let replyText = '';
                    let adminNotifyText = '';
                    const data = slipResult.data || {};
                    const senderName = data.sender?.displayName || 'ไม่ระบุชื่อ';
                    const amount = data.amount || 0;

                    if (slipRes.ok && slipResult.success) {
                        replyText = '✅ ตรวจสอบสลิปสำเร็จ! ระบบได้ส่งข้อมูลให้เจ้าของหอยืนยันเรียบร้อยครับ';
                        adminNotifyText = `📢 มีการชำระเงินผ่าน LINE Bot!\nผู้โอน: ${senderName}\nยอดเงิน: ${amount} บาท\n\n✅ สลิปถูกต้อง (ตรวจสอบโดย SlipOK)\nฝากเจ้าของหอยืนยันอีกครั้งครับ`;
                    } else {
                        replyText = '❌ สลิปไม่ถูกต้อง หรือถูกใช้ซ้ำแล้ว กรุณาตรวจสอบอีกครั้งครับ';
                        adminNotifyText = `⚠️ แจ้งเตือนสลิปมีปัญหาจากผู้เช่า!\nผลการตรวจสอบ: ❌ ${slipResult.message || 'สลิปไม่ถูกต้อง'}`;
                    }

                    // ส่งข้อความตอบกลับผู้เช่า
                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                        },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{ type: 'text', text: replyText }]
                        })
                    });

                    // ส่งแจ้งเตือนให้เจ้าของหอ (Admin)
                    const adminLineId = process.env.ADMIN_LINE_ID;
                    if (adminLineId) {
                        if (slipRes.ok && slipResult.success) {
                            // กรณีสลิปถูกต้อง: ส่ง Flex Message พร้อมปุ่มกดยืนยัน
                            const flexMessage = {
                                type: "flex",
                                altText: "มีการส่งสลิปใหม่ รอการยืนยัน",
                                contents: {
                                    type: "bubble",
                                    body: {
                                        type: "box",
                                        layout: "vertical",
                                        contents: [
                                            { type: "text", text: "📢 แจ้งเตือนชำระเงินใหม่", weight: "bold", size: "xl", color: "#1f2937" },
                                            { type: "text", text: `ผู้โอน: ${senderName}`, margin: "md", color: "#4b5563" },
                                            { type: "text", text: `ยอดเงิน: ${amount} บาท`, color: "#4b5563" },
                                            { type: "text", text: "✅ สลิปถูกต้อง (SlipOK)", color: "#10b981", margin: "md", weight: "bold" }
                                        ]
                                    },
                                    footer: {
                                        type: "box",
                                        layout: "vertical",
                                        contents: [
                                            {
                                                type: "button",
                                                style: "primary",
                                                color: "#4f46e5",
                                                action: {
                                                    type: "postback",
                                                    label: "✅ ยืนยันรับยอด",
                                                    // ส่ง billName แนบไปให้ Admin ยืนยันเฉพาะใบนั้น
                                                    data: `action=confirm_slip&userId=${event.source.userId}&amount=${amount}&billName=${encodeURIComponent(pendingBill)}`
                                                }
                                            }
                                        ]
                                    }
                                }
                            };

                            await fetch('https://api.line.me/v2/bot/message/push', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                                },
                                body: JSON.stringify({
                                    to: adminLineId,
                                    messages: [flexMessage]
                                })
                            });
                        } else {
                            // กรณีสลิปมีปัญหา: ส่ง ข้อความแจ้งเตือนปัญหาสลิป
                            await fetch('https://api.line.me/v2/bot/message/push', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                                },
                                body: JSON.stringify({
                                    to: adminLineId,
                                    messages: [{ type: 'text', text: adminNotifyText }]
                                })
                            });
                        }
                    }
                }
            }

            // 3. ดักจับเมื่อแอดมินกด "ปุ่มยืนยัน" จาก Flex Message (Postback Event)
            if (event.type === 'postback') {
                const postbackData = new URLSearchParams(event.postback.data);
                const action = postbackData.get('action');
                
                if (action === 'confirm_slip') {
                    const tenantId = postbackData.get('userId');
                    const amount = postbackData.get('amount');
                    const billName = postbackData.get('billName'); // รับค่าชื่อบิล
                    
                    if (tenantId) {
                        try {
                            const roomRes = await pool.query(`
                                SELECT r.id, r.number
                                FROM rooms r
                                JOIN tenants t ON r.tenant = t.name
                                WHERE t.line_id = $1 LIMIT 1
                            `, [tenantId]);

                            if (roomRes.rows.length > 0) {
                                const room = roomRes.rows[0];
                                
                                // กรณีเลือกชำระแบบเจาะจงบิล
                                if (billName && billName !== 'null' && billName !== '') {
                                    // 1. อัปเดตสถานะบิลใบนั้นในตาราง bills เป็น 'ชำระเงินแล้ว'
                                    const billIdMatch = billName.match(/#(\d+)/);
                                    if (billIdMatch) {
                                        const billId = billIdMatch[1];
                                        await pool.query(`UPDATE bills SET status = 'ชำระเงินแล้ว' WHERE id = $1`, [billId]);
                                    } else {
                                        const filePath = path.join(__dirname, 'public', 'exports', billName);
                                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
                                    }

                                    // 2. เช็คว่ายังเหลือบิลใบอื่นของห้องนี้ค้างอยู่อีกหรือไม่
                                    const remainingBillsRes = await pool.query(`
                                        SELECT * FROM bills 
                                        WHERE room_number = $1 AND status = 'ค้างชำระ'
                                    `, [room.number]);

                                    // 3. ถ้าไม่เหลือบิลค้างชำระแล้ว ให้เปลี่ยนสถานะห้องพักเป็น 'ชำระเงินแล้ว'
                                    if (remainingBillsRes.rows.length === 0) {
                                        await pool.query(`UPDATE rooms SET payment_status = 'ชำระเงินแล้ว' WHERE id = $1`, [room.id]);
                                    }
                                    
                                    pendingSlipBills.delete(tenantId);
                                } else {
                                    // การยืนยันแบบปกติ
                                    await pool.query(`UPDATE bills SET status = 'ชำระเงินแล้ว' WHERE room_number = $1`, [room.number]);
                                    await pool.query(`UPDATE rooms SET payment_status = 'ชำระเงินแล้ว' WHERE id = $1`, [room.id]);
                                }
                            }
                        } catch (err) {
                            console.error('Update Payment Status Error:', err);
                        }
                    }

                    // 2. แจ้งแอดมิน 
                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                        },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{ type: 'text', text: `✅ คุณได้ยืนยันรับยอด ${amount} บาท เรียบร้อยแล้ว (ระบบกำลังแจ้งผู้เช่า)` }]
                        })
                    });

                    if (tenantId) {
                        await fetch('https://api.line.me/v2/bot/message/push', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                            },
                            body: JSON.stringify({
                                to: tenantId,
                                messages: [{ type: 'text', text: `🎉 เจ้าของหอยืนยันการรับยอดชำระเงินจำนวน ${amount} บาท ของคุณเรียบร้อยแล้ว ขอบคุณครับ` }]
                            })
                        });
                    }
                }
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).send('Error');
    }
});

// ดึงรายชื่อเพื่อนเพื่อไปแสดงในช่องค้นหาหน้า UI
app.get(`${apiPrefix}/line-friends`, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM line_friends ORDER BY display_name ASC');
        res.json({ success: true, friends: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Database error' });
    }
});
/*
|--------------------------------------------------------------------------
| EXPORTED BILLS API 
|--------------------------------------------------------------------------
*/

// 1. ดึงรายการบิลทั้งหมด
const getExportedBillsHandler = async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bills ORDER BY id DESC');
        const imageFiles = result.rows.map(bill => ({
            id: bill.id,
            name: `Bill_Room_${bill.room_number}`,
            url: bill.bill_url,
            download_url: `${apiPrefix}/exported-bills/${bill.id}/download`,
            payment_status: bill.status,
            room_number: bill.room_number,
            created_at: bill.created_at
        }));
        res.json({ success: true, files: imageFiles });
    } catch (error) {
        console.error('Database Error in exported bills:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
};

app.get(`${apiPrefix}/exported-bills`, getExportedBillsHandler);
app.get(`${apiPrefix}/bills`, getExportedBillsHandler);

// 2. API สำหรับดาวน์โหลดไฟล์บิลลงเครื่องโดยตรง (Download Proxy)
const downloadBillHandler = async (req, res) => {
    try {
        const { id } = req.params;
        const billRes = await pool.query('SELECT * FROM bills WHERE id = $1', [id]);
        
        if (billRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบบิลที่ต้องการดาวน์โหลด' });
        }

        const bill = billRes.rows[0];
        const response = await fetch(bill.bill_url);
        
        if (!response.ok) {
            return res.status(400).json({ success: false, message: 'ไม่สามารถดึงรูปภาพบิลจากระบบได้' });
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const fileName = `Bill_Room_${bill.room_number}_${bill.id}.png`;

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(buffer);
    } catch (error) {
        console.error('Download Bill Error:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดาวน์โหลดบิล' });
    }
};

app.get(`${apiPrefix}/exported-bills/:id/download`, downloadBillHandler);
app.get(`${apiPrefix}/bills/:id/download`, downloadBillHandler);

// 3. API สำหรับลบบิล (รองรับการลบทั้งจาก Cloudinary, PostgreSQL และไฟล์ Local)
async function deleteBillHandler(req, res) {
    try {
        const rawParam = req.params.id || req.params[0] || req.params.filename || '';
        const identifier = decodeURIComponent(rawParam).trim();

        if (!identifier) {
            return res.status(400).json({
                success: false,
                message: 'กรุณาระบุบิลที่ต้องการลบ'
            });
        }

        // 1. ตัดนามสกุลไฟล์ออก (.png, .jpg, .jpeg, .webp)
        let cleaned = identifier.replace(/\.(png|jpg|jpeg|webp)$/i, '');

        // 2. ดึงเฉพาะเลขห้อง หรือ ID หากมี Prefix เช่น Bill_Room_101_12 หรือ Bill_Room_101
        let extractedRoom = null;
        let extractedId = null;

        const roomAndIdMatch = cleaned.match(/^Bill_Room_([^_]+)_(\d+)$/i);
        const roomOnlyMatch = cleaned.match(/^Bill_Room_([^_]+)$/i);

        if (roomAndIdMatch) {
            extractedRoom = roomAndIdMatch[1];
            extractedId = parseInt(roomAndIdMatch[2], 10);
        } else if (roomOnlyMatch) {
            extractedRoom = roomOnlyMatch[1];
        }

        // 3. ค้นหาบิลที่จะลบแบบยืดหยุ่น (รองรับ id, room_number, public_id, bill_url)
        let findQuery = `
            SELECT * FROM bills 
            WHERE id::text = $1 
               OR room_number = $1 
               OR public_id = $1 
               OR bill_url = $1
               OR public_id LIKE $2
        `;
        let findParams = [cleaned, `%${cleaned}%`];

        if (extractedId) {
            findQuery += ` OR id = ${extractedId}`;
        }
        if (extractedRoom) {
            findQuery += ` OR room_number = '${extractedRoom}'`;
        }

        findQuery += ` ORDER BY id DESC LIMIT 1`;

        const findResult = await pool.query(findQuery, findParams);

        if (findResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'ไม่พบบิลที่ต้องการลบในระบบ'
            });
        }

        const billToDelete = findResult.rows[0];

        // 4. ลบข้อมูลบิลจากฐานข้อมูล PostgreSQL
        const deleteResult = await pool.query('DELETE FROM bills WHERE id = $1 RETURNING *', [billToDelete.id]);

        if (deleteResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'ไม่พบบิลที่ต้องการลบในระบบ'
            });
        }

        const deletedBill = deleteResult.rows[0];

        // 5. ลบรูปภาพบน Cloudinary (ถ้ามี public_id)
        if (deletedBill.public_id) {
            try {
                await cloudinary.uploader.destroy(deletedBill.public_id);
            } catch (cloudErr) {
                console.error('Cloudinary Delete Error:', cloudErr);
            }
        }

        // 6. ลบไฟล์จริงออกจากโฟลเดอร์ /public/exports (กรณีมีไฟล์ local)
        const possibleFilenames = [
            identifier,
            cleaned,
            `${cleaned}.png`,
            `Bill_Room_${deletedBill.room_number}.png`,
            `Bill_Room_${deletedBill.room_number}_${deletedBill.id}.png`
        ];

        for (const fname of possibleFilenames) {
            const filePath = path.join(__dirname, 'public', 'exports', fname);
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                } catch (e) {
                    console.error('File Unlink Error:', e);
                }
            }
        }

        return res.json({ 
            success: true, 
            message: 'ลบบิลเรียบร้อยแล้ว' 
        });

    } catch (error) {
        console.error('Delete Bill Error:', error);
        return res.status(500).json({ 
            success: false, 
            message: error.message || 'เกิดข้อผิดพลาดในการลบบิล' 
        });
    }
}

// กำหนด Route รองรับทั้ง Parameter ID ปกติ และ Wildcard สำหรับ path ที่มีเครื่องหมาย /
app.delete(`${apiPrefix}/exported-bills/*`, deleteBillHandler);
app.delete(`${apiPrefix}/exported-bills/:id`, deleteBillHandler);
app.delete(`${apiPrefix}/bills/*`, deleteBillHandler);
app.delete(`${apiPrefix}/bills/:id`, deleteBillHandler);
/*
|--------------------------------------------------------------------------
| Rooms
|--------------------------------------------------------------------------
*/

// ดึงห้องทั้งหมด
app.get(`${apiPrefix}/rooms`, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.*, d.name as dormitory_name, t.line_id 
            FROM rooms r
            LEFT JOIN dormitories d ON r.dormitory_id = d.id
            LEFT JOIN tenants t ON r.tenant = t.name
            ORDER BY r.number ASC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Rooms Error:', error);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});
// แก้ไขข้อมูลห้องพัก

app.post(`${apiPrefix}/rooms`, async (req, res) => {
    const { dormitory_id, number, type, price, status, tenant, is_moving_out, move_out_day, move_out_month } = req.body;

    if (!dormitory_id || !number || !price) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกกลุ่มหอพัก กรอกเลขห้อง และราคา' });
    }

    const roomTenant = status === 'Occupied' ? (tenant || 'ไม่ระบุชื่อ') : '-';

    try {
        const result = await pool.query(`
            INSERT INTO rooms (dormitory_id, branch_id, number, type, price, status, tenant, is_moving_out, move_out_day, move_out_month)
            VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [dormitory_id, number, type, price, status, roomTenant, is_moving_out || false, move_out_day || null, move_out_month || null]);

        res.json({ success: true, message: 'เพิ่มห้องพักสำเร็จ!', room: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด', error: error.message });
    }
});

// 4. อัปเดต API แก้ไขห้องพัก (PUT /api/rooms/:id)
app.put(`${apiPrefix}/rooms/:id`, async (req, res) => {
    const { id } = req.params;
    const { 
        dormitory_id, number, type, price, status, tenant, 
        is_moving_out, move_out_day, move_out_month, image_data 
    } = req.body;

    if (!dormitory_id || !number || !price) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    }

    const roomTenant = status === 'Occupied' ? (tenant || 'ไม่ระบุชื่อ') : '-';

    try {
        const result = await pool.query(`
            UPDATE rooms
            SET dormitory_id = $1, number = $2, type = $3, price = $4, status = $5, tenant = $6,
                is_moving_out = $7, move_out_day = $8, move_out_month = $9, image_data = $10
            WHERE id = $11
            RETURNING *
        `, [
            dormitory_id, number, type, price, status, roomTenant, 
            is_moving_out || false, move_out_day || null, move_out_month || null, 
            image_data || null, id
        ]);

        res.json({ success: true, message: 'แก้ไขข้อมูลห้องพักสำเร็จ!', room: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด', error: error.message });
    }
});

// ลบห้องพัก
app.delete(`${apiPrefix}/rooms/:id`, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            'DELETE FROM rooms WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'ไม่พบห้องพักที่ต้องการลบ'
            });
        }

        res.json({
            success: true,
            message: 'ลบห้องพักสำเร็จ'
        });
    } catch (error) {
        console.error('Delete Room Error:', error);
        res.status(500).json({
            success: false,
            message: 'ไม่สามารถลบห้องพักได้',
            error: error.message
        });
    }
});


// เพิ่มห้องพัก
app.post(`${apiPrefix}/rooms`, async (req, res) => {
    const { dormitory_id, number, type, price, status, tenant, is_moving_out, move_out_day, move_out_month } = req.body;

    if (!dormitory_id || !number || !price) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกกลุ่มหอพัก กรอกเลขห้อง และราคา' });
    }

    const roomTenant = status === 'Occupied' ? (tenant || 'ไม่ระบุชื่อ') : '-';

    try {
        const result = await pool.query(`
            INSERT INTO rooms (dormitory_id, branch_id, number, type, price, status, tenant, is_moving_out, move_out_day, move_out_month)
            VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [dormitory_id, number, type, price, status, roomTenant, is_moving_out || false, move_out_day || null, move_out_month || null]);

        res.json({ success: true, message: 'เพิ่มห้องพักสำเร็จ!', room: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด', error: error.message });
    }
});
// =====================================================
// QR Code Generation and PromptPay
// =====================================================
const qrcode = require('qrcode');
const generatePayload = require('promptpay-qr');
// ฟังก์ชันแปลงรูปแบบเดือน เช่น 2026-09 -> กันยายน 2569
function formatThaiMonth(yyyy_mm) {
    if (!yyyy_mm) return 'ไม่ระบุ'; 
    // แก้ไขจาก yyy_mm เป็น yyyy_mm (เพิ่ม y ให้ครบ 4 ตัว)
    const [year, month] = yyyy_mm.split('-'); 
    const thaiMonths = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
    return `${thaiMonths[parseInt(month) - 1]} ${parseInt(year) + 543}`;
}


// ฟังก์ชันแปลงตัวเลขเป็นตัวอักษรภาษาไทย (บาทถ้วน)
function getThaiBahtText(amount) {
    const data = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
    const position = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน', 'ล้าน'];
    let numberString = Math.floor(amount).toString();
    let text = '';
    
    for (let i = 0; i < numberString.length; i++) {
        let n = parseInt(numberString[i]);
        let pos = numberString.length - i - 1;
        if (n !== 0) {
            if (pos === 1 && n === 1) text += 'สิบ';
            else if (pos === 1 && n === 2) text += 'ยี่สิบ';
            else if (pos === 0 && n === 1 && numberString.length > 1) text += 'เอ็ด';
            else text += data[n] + position[pos];
        }
    }
    return text + 'บาทถ้วน';
}

// ฟังก์ชันสำหรับอัปโหลด Buffer รูปภาพขึ้น Cloudinary
function uploadBufferToCloudinary(buffer, folderName = 'dorm_bills') {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: folderName, resource_type: 'image' },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        uploadStream.end(buffer);
    });
}
// ฟังก์ชันช่วยแปลงวันที่ให้อยู่ในโซนเวลาท้องถิ่น ป้องกันปัญหาเรื่อง Timezone
function parseLocalDate(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return dateStr;
    if (typeof dateStr === 'string') {
        const match = dateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (match) {
            return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
        }
    }
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}
// ฟังก์ชันสร้าง Workbook ตามแบบฟอร์มในภาพ
// ฟังก์ชันสร้างรูปภาพบิลแทน Excel
async function createBillingImage(room, inputs, filePath) {
    const roomPrice = Number(room.price || 3000);
    // 🟢 อ่านค่าธนาคารรองรับทั้ง snake_case, camelCase และ pay*
    const payBank = inputs.payBank || inputs.bank_name || inputs.bankName || 'ไม่ระบุ';
    const payAccountNo = inputs.payAccountNo || inputs.account_number || inputs.accountNumber || 'ไม่ระบุ';
    const payName = inputs.payName || inputs.account_name || inputs.accountName || 'ไม่ระบุ';
    const payPhone = inputs.payPhone || inputs.phone || '-';
    const qrImage = inputs.payQrBase64 || inputs.qr_image || inputs.qrImage;
    const payTextLine1 = inputs.payMethod === 'qr' ? 'กรุณาชำระเงินผ่านการสแกน QR Code' : `กรุณาชำระเงินผ่านบัญชี "${inputs.payBank}"`;
    const payTextLine2 = inputs.payMethod === 'qr' ? `ชื่อบัญชี: ${inputs.payName}` : `เลขบัญชี ${inputs.payAccountNo}  ชื่อบัญชี ${inputs.payName}`;
    const formattedMonth = formatThaiMonth(inputs.billMonth);

    const ePrev = Number(inputs.elecPrev);
    const eCurr = Number(inputs.elecCurr);
    const eUnits = eCurr - ePrev;
    const eTotal = eUnits * Number(inputs.elecRate);

    const wPrev = Number(inputs.waterPrev);
    const wCurr = Number(inputs.waterCurr);
    const wUnits = wCurr - wPrev;
    let wTotal = wUnits <= 4 ? 100 : wUnits * 25;
    

    let optFeeTotal = 0;
    let optFeeRowHTML = '';
    let rowNumber = 4;
    

    if (inputs.optFeeCheck && inputs.optFees && Array.isArray(inputs.optFees)) {
        inputs.optFees.forEach(fee => {
            const feeAmount = Number(fee.amount) || 0;
            optFeeTotal += feeAmount;
            
            optFeeRowHTML += `
                <tr>
                    <td>${rowNumber++}</td>
                    <td style="text-align: left;">${fee.name}</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                    <td class="text-right">${feeAmount.toFixed(2)}</td>
                </tr>
            `;
        });
    }

    // คำนวณค่าปรับล่าช้า (หากสร้างบิลหลังวันครบกำหนด)
    // คำนวณค่าปรับล่าช้า (หากสร้างบิลหลังวันครบกำหนด หรือดูบิลย้อนหลัง)
    const rawDueDate = inputs.billDueDate || inputs.bill_due_date || inputs.dueDate || room.bill_due_date;
    let finePerDay = Number(inputs.finePerDay || inputs.fine_per_day || room.fine_per_day) || 0;
    let fineAmount = 0;
    let overdueDays = 0;

    let dueDateText = 'ไม่ระบุ';
    if (rawDueDate) {
        const d = parseLocalDate(rawDueDate);
        if (d) {
            dueDateText = d.toLocaleDateString('th-TH', { 
                day: 'numeric', 
                month: 'long', 
                year: 'numeric',
                timeZone: 'Asia/Bangkok'
            });
        } else {
            dueDateText = rawDueDate; // Fallback หากส่งมาเป็นข้อความสำเร็จรูปแล้ว
        }
    }

    if (rawDueDate && finePerDay > 0) {
        const dueDate = parseLocalDate(rawDueDate);
        if (dueDate) {
            const today = new Date();
            dueDate.setHours(0, 0, 0, 0);
            today.setHours(0, 0, 0, 0);

            if (today > dueDate) {
                overdueDays = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
                if (overdueDays > 0) {
                    fineAmount = overdueDays * finePerDay;

                    optFeeRowHTML += `
                        <tr style="color: #dc2626; font-weight: bold;">
                            <td>${rowNumber++}</td>
                            <td style="text-align: left;">ค่าปรับชำระเกินกำหนด (${overdueDays} วัน x ${finePerDay} บาท)</td>
                            <td>-</td>
                            <td>-</td>
                            <td>-</td>
                            <td class="text-right">${fineAmount.toFixed(2)}</td>
                        </tr>
                    `;
                }
            }
        }
    }

    const grandTotal = roomPrice + eTotal + wTotal + optFeeTotal + fineAmount;
    const currentDate = new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });

    let qrHtml = '';
    if ((inputs.payMethod === 'qr' || qrImage) && qrImage) {
        qrHtml = `<img src="${qrImage}" style="width: 140px; height: 140px; margin-top: 15px; border: 1px solid #ccc; padding: 5px;" />`;
    }

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="th">
    <head>
        <meta charset="UTF-8">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap');
            body { font-family: 'Sarabun', sans-serif; background-color: #fff; width: 800px; padding: 40px; color: #000; }
            .text-center { text-align: center; }
            .text-right { text-align: right; }
            .bold { font-weight: 700; }
            .title { font-size: 26px; margin-bottom: 5px; }
            .subtitle { font-size: 22px; margin-bottom: 25px; }
            .info-row { display: flex; justify-content: space-between; font-size: 20px; margin-bottom: 10px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 20px; }
            th, td { border: 1px solid #000; padding: 12px; text-align: center; }
            .footer { margin-top: 30px; text-align: center; font-size: 20px; }
            .due-box { margin-top: 20px; padding: 12px; background-color: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; font-size: 18px; color: #c2410c; }
        </style>
    </head>
    <body>
        <div class="text-center bold title">${inputs.dormName || 'ไม่ระบุชื่อหอพัก'}</div>
        <div class="text-center bold subtitle">ใบแจ้งหนี้ / ใบเสร็จรับเงิน</div>
        
        <div class="info-row bold">
            <span>ประจำเดือน: ${formattedMonth}</span>
        </div>
        <div class="info-row">
            <span class="bold">หมายเลขห้องพัก: ${room.number}</span>
            <span class="bold">ชื่อผู้เช่า: ${room.tenant}</span>
        </div>
        <div class="info-row">
            <span>วันที่ออกบิล: ${currentDate}</span>
        </div>

        <table>
            <thead>
                <tr class="bold" style="background-color: #f9f9f9;">
                    <th>ลำดับ</th>
                    <th>รายการ</th>
                    <th>เดือนก่อน</th>
                    <th>เดือนนี้</th>
                    <th>หน่วยที่ใช้</th>
                    <th>จำนวนเงิน (บาท)</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>1</td>
                    <td style="text-align: left;">ค่าห้องพัก/เดือน</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                    <td class="text-right">${roomPrice.toFixed(2)}</td>
                </tr>
                <tr>
                    <td>2</td>
                    <td style="text-align: left;">ค่าไฟฟ้า</td>
                    <td>${ePrev}</td>
                    <td>${eCurr}</td>
                    <td>${eUnits}</td>
                    <td class="text-right">${eTotal.toFixed(2)}</td>
                </tr>
                <tr>
                    <td>3</td>
                    <td style="text-align: left;">ค่าน้ำประปา</td>
                    <td>${wPrev}</td>
                    <td>${wCurr}</td>
                    <td>${wUnits}</td>
                    <td class="text-right">${wTotal.toFixed(2)}</td>
                </tr>
                ${optFeeRowHTML}
                <tr class="bold">
                    <td colspan="2">รวมเป็นเงิน</td>
                    <td colspan="3">${getThaiBahtText(grandTotal)}</td>
                    <td class="text-right">${grandTotal.toFixed(2)}</td>
                </tr>
            </tbody>
        </table>

        ${rawDueDate ? `
        <div class="due-box text-center bold">
            ⚠️ กำหนดชำระเงินภายในวันที่: ${dueDateText}${finePerDay > 0 ? `(หากเกินกำหนด มีค่าปรับ ${finePerDay} บาท/วัน)` : ''}
        </div>
        ` : ''}

        <div class="footer">
            <div class="bold">${payTextLine1}</div>
            <div class="bold" style="font-size: 22px; color: #1d4ed8; margin-top: 5px;">${payTextLine2}</div>
            <div style="margin-top: 5px;">เบอร์ติดต่อ: ${inputs.payPhone}</div>
            ${qrHtml}
        </div>
    </body>
    </html>
    `;

    const browser = await puppeteer.launch({ 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'] 
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    const bodyHandle = await page.$('body');
    const boundingBox = await bodyHandle.boundingBox();
    await page.setViewport({ width: 880, height: Math.ceil(boundingBox.height) });

    // รับภาพเป็น Buffer แทนการเซฟลงดิสก์ local
    const imageBuffer = await page.screenshot({ type: 'png' });
    await browser.close(); 

    // อัปโหลดขึ้น Cloudinary
    const uploadResult = await uploadBufferToCloudinary(imageBuffer);
    return uploadResult; // จะได้ออบเจกต์ที่มี secure_url และ public_id
}

// =====================================================
// นำ API 2 ตัวนี้ไปแทนที่ /api/generate-bills และ /api/export-billing-excel เดิม
// =====================================================

app.post(`${apiPrefix}/generate-bills`, async (req, res) => {
    const billDueDate = req.body.billDueDate || req.body.bill_due_date || req.body.dueDate;
    const finePerDay = Number(req.body.finePerDay || req.body.fine_per_day) || 0;
    const { dormName, roomNumber, lineUserId } = req.body;

    // Normalize คีย์ลง req.body
    req.body.billDueDate = billDueDate;
    req.body.finePerDay = finePerDay;
    try {
        const result = await pool.query(`
            SELECT r.*, d.name as dormitory_name 
            FROM rooms r
            JOIN dormitories d ON r.dormitory_id = d.id
            WHERE r.number = $1 AND d.name = $2 AND r.status = 'Occupied'
        `, [roomNumber, dormName]);

        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบห้องที่ระบุ หรือห้องยังไม่มีผู้เช่า' });
        
        const room = result.rows[0];

        // 🟢 1. อ่านค่าธนาคารรองรับคีย์ทุกรูปแบบ
        let payBank = req.body.payBank || req.body.bank_name || req.body.bankName;
        let payAccountNo = req.body.payAccountNo || req.body.account_number || req.body.accountNumber;
        let payName = req.body.payName || req.body.account_name || req.body.accountName;
        let payPhone = req.body.payPhone || req.body.phone;
        let payQrBase64 = req.body.payQrBase64 || req.body.qr_image || req.body.qrImage;


        // 🟢 2. หากใน Request ไม่มีข้อมูล ให้ดึงบัญชีล่าสุดจากตาราง payment_accounts อัตโนมัติ
        if (!payBank || !payAccountNo) {
            const defaultAcc = await pool.query('SELECT * FROM payment_accounts ORDER BY id DESC LIMIT 1');
            if (defaultAcc.rows.length > 0) {
                const acc = defaultAcc.rows[0];
                payBank = payBank || acc.bank_name;
                payAccountNo = payAccountNo || acc.account_number;
                payName = payName || acc.account_name;
                payPhone = payPhone || acc.phone;
                payQrBase64 = payQrBase64 || acc.qr_image;
            }
        }

        // นำค่าที่ Normalize แล้วใส่กลับลงใน req.body
        req.body.payBank = payBank;
        req.body.payAccountNo = payAccountNo;
        req.body.payName = payName;
        req.body.payPhone = payPhone;
        req.body.payQrBase64 = payQrBase64;

        if (payAccountNo) {
            const existingAcc = await pool.query('SELECT id FROM payment_accounts WHERE account_number = $1', [payAccountNo]);
            if (existingAcc.rows.length > 0) {
                await pool.query(
                    `UPDATE payment_accounts 
                     SET bank_name = COALESCE($1, bank_name), 
                         account_name = COALESCE($2, account_name), 
                         phone = COALESCE($3, phone), 
                         qr_image = COALESCE($4, qr_image)
                     WHERE account_number = $5`,
                    [payBank, payName, payPhone, payQrBase64, payAccountNo]
                );
            } else {
                await pool.query(
                    `INSERT INTO payment_accounts (bank_name, account_number, account_name, phone, qr_image)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [payBank, payAccountNo, payName, payPhone, payQrBase64]
                );
            }
        }

        // สร้างรูปบิลและอัปโหลดขึ้น Cloudinary
        const uploadResult = await createBillingImage(room, req.body);
        const fileUrl = uploadResult.secure_url;

        // บันทึก URL บิลลงในตาราง bills
        await pool.query(`
            INSERT INTO bills (room_number, bill_url, public_id, status, bill_data)
            VALUES ($1, $2, $3, 'ค้างชำระ', $4)
        `, [room.number, fileUrl, uploadResult.public_id, JSON.stringify(req.body)]);

        // อัปเดตสถานะในตาราง rooms
        await pool.query(`
            UPDATE rooms 
            SET payment_status = 'ค้างชำระ', 
                bill_due_date = $1, 
                fine_per_day = $2,
                last_bill_data = $3
            WHERE id = $4
        `, [billDueDate || null, finePerDay || 0, JSON.stringify(req.body), room.id]);

        if (lineUserId) {
            const formattedMonth = formatThaiMonth(req.body.billMonth);
            let messageText = `📝 แจ้งยอดค่าใช้จ่าย ประจำเดือน: ${formattedMonth}\n🚪 ห้อง: ${room.number}\n👤 ผู้เช่า: ${room.tenant}`;

            if (billDueDate) {
                const d = new Date(billDueDate);
                const dueDateFormatted = !isNaN(d.getTime()) 
                    ? d.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' }) 
                    : billDueDate;
                messageText += `\n📅 กำหนดชำระภายใน: ${dueDateFormatted}`;
                if (finePerDay > 0) messageText += `\n⚠️ ค่าปรับกรณีเกินกำหนด: ${finePerDay} บาท/วัน`;
            }
            
            messageText += `\n\nตรวจสอบรายละเอียดบิลจากรูปภาพด้านล่างครับ 👇`;

            await fetch('https://api.line.me/v2/bot/message/push', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                },
                body: JSON.stringify({
                    to: lineUserId,
                    messages: [
                        { type: 'text', text: messageText },
                        { type: 'image', originalContentUrl: fileUrl, previewImageUrl: fileUrl }
                    ]
                })
            });
        }

        res.json({
            success: true,
            message: lineUserId ? 'ระบบคำนวณและส่งรูปภาพบิลให้ผู้เช่าทาง LINE สำเร็จ!' : 'สร้างรูปภาพบิลเรียบร้อยแล้ว (ไม่ได้ส่งเข้า LINE)'
        });
    } catch (error) {
        console.error('Generate Bills Error:', error);
        res.status(500).json({ success: false, message: 'Database/Server error' });
    }
});

// ฟังก์ชันส่งแจ้งเตือนเข้า LINE เมื่อถึงวันกำหนดชำระ หรือ ชำระเกินกำหนด
async function checkAndSendDueDateReminders() {
    try {
        const result = await pool.query(`
            SELECT r.*, t.line_id 
            FROM rooms r
            JOIN tenants t ON r.tenant = t.name
            WHERE r.payment_status = 'ค้างชำระ' 
              AND r.bill_due_date IS NOT NULL
              AND t.line_id IS NOT NULL
        `);

        for (const room of result.rows) {
            const dueDate = new Date(room.bill_due_date);
            const today = new Date();
            dueDate.setHours(0, 0, 0, 0);
            today.setHours(0, 0, 0, 0);

            const diffDays = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
            const fineRate = Number(room.fine_per_day || 0);

            if (diffDays === 0) {
                const text = `⏰ แจ้งเตือนครบกำหนดชำระเงินวันนี้!\n🏢 ห้อง: ${room.number}\n👤 คุณ: ${room.tenant}\n\nวันนี้เป็นวันครบกำหนดชำระค่าเช่าห้องพักแล้วครับ${fineRate > 0 ? `\n⚠️ *กรณีเกินกำหนดจะมีค่าปรับ ${fineRate} บาท/วัน` : ''}\nกรุณาชำระเงินและส่งสลิปเพื่อยืนยันครับ`;
                await sendLinePushMessage(room.line_id, text);
            } else if (diffDays > 0 && fineRate > 0) {
                if (room.last_bill_data) {
                    try {
                        const billData = JSON.parse(room.last_bill_data);
                        const uploadResult = await createBillingImage(room, billData);
                        
                        if (uploadResult && uploadResult.secure_url) {
                            await pool.query(
                                `UPDATE bills SET bill_url = $1, public_id = $2 WHERE room_number = $3 AND status = 'ค้างชำระ'`,
                                [uploadResult.secure_url, uploadResult.public_id, room.number]
                            );
                        }
                    } catch (e) {
                        console.error(`Failed to regenerate updated bill for room ${room.number}:`, e);
                    }
                }

                const currentFine = diffDays * fineRate;
                const text = `⚠️ แจ้งเตือนเกินกำหนดชำระเงิน!\n🏢 ห้อง: ${room.number}\n👤 คุณ: ${room.tenant}\n\nเกินกำหนดชำระมาแล้ว ${diffDays} วัน\n💸 มีค่าปรับล่าช้าสะสม: ${currentFine.toLocaleString()} บาท (วันละ ${fineRate} บาท)\n\nระบบได้อัปเดตยอดค่าปรับลงในสลิปบิลของคุณเรียบร้อยแล้ว\nพิมพ์ "ตรวจสอบบิลค้างชำระ" หรือ "ชำระเงินทั้งหมด" เพื่อดูสลิปล่าสุดและทำรายการครับ`;
                
                await sendLinePushMessage(room.line_id, text);
            }
        }
    } catch (error) {
        console.error('Check Due Date Reminders Error:', error);
    }
}

// ฟังก์ชันช่วยส่ง Push Message เข้า LINE
async function sendLinePushMessage(toLineId, text) {
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !toLineId) return;
    await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
            to: toLineId,
            messages: [{ type: 'text', text }]
        })
    }).catch(err => console.error('LINE Push Error:', err));
}

// ตั้งเวลาตรวจเช็กทุกวัน เวลา 09:00 น. (หรือรันทุก 24 ชม.)
setInterval(() => {
    const now = new Date();
    if (now.getHours() === 9 && now.getMinutes() === 0) {
        checkAndSendDueDateReminders();
    }
}, 60 * 1000);

app.get(`${apiPrefix}/export-billing-excel`, async (req, res) => {
    try {
        const { roomNumber, dormName } = req.query;

        const result = await pool.query(`
            SELECT r.*, d.name as dormitory_name 
            FROM rooms r
            JOIN dormitories d ON r.dormitory_id = d.id
            WHERE r.number = $1 AND d.name = $2 AND r.status = 'Occupied'
        `, [roomNumber, dormName]);

        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบห้องที่ระบุ หรือไม่มีผู้เช่า' });

        const workbook = await createBillingWorkbook(result.rows[0], req.query);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Bill_Room_${roomNumber}.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Excel Export Error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถสร้างไฟล์ Excel ได้' });
    }
});

// =====================================================
// Dormitories (กลุ่มหอพัก)
// =====================================================

app.get(`${apiPrefix}/dormitories`, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM dormitories ORDER BY id ASC');
        res.json({ success: true, dormitories: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post(`${apiPrefix}/dormitories`, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อหอพัก' });
        
        const result = await pool.query('INSERT INTO dormitories (name) VALUES ($1) RETURNING *', [name]);
        res.json({ success: true, message: 'เพิ่มหอพักสำเร็จ', dormitory: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put(`${apiPrefix}/dormitories/:id`, async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        await pool.query('UPDATE dormitories SET name = $1 WHERE id = $2', [name, id]);
        res.json({ success: true, message: 'แก้ไขชื่อหอพักสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete(`${apiPrefix}/dormitories/:id`, async (req, res) => {
    try {
        await pool.query('DELETE FROM dormitories WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'ลบหอพักสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/*
|--------------------------------------------------------------------------
| CARD SYSTEM
|--------------------------------------------------------------------------
*/


// --------------------------------------------------
// GET /api/cards
// --------------------------------------------------

app.get(`${apiPrefix}/cards`, async (req, res) => {

    try {

        const result = await pool.query(`
            SELECT
                id,
                title,
                description,
                image_data
            FROM cards
            ORDER BY id DESC
        `);

        res.json(result.rows);

    } catch (error) {

        console.error('GET CARDS ERROR:', error);

        res.status(500).json({
            success: false,
            error: 'Database error',
            message: error.message
        });

    }

});

// --------------------------------------------------
// POST /api/cards
// --------------------------------------------------

app.post(`${apiPrefix}/cards`, async (req, res) => {

    try {

        const {
            title,
            desc,
            image
        } = req.body;


        // Validate
        if (!title || title.trim() === '') {

            return res.status(400).json({

                success: false,

                message: 'กรุณากรอกหัวข้อการ์ด'

            });

        }


        // ป้องกัน undefined
        const cardTitle = title.trim();

        const cardDescription =
            typeof desc === 'string'
                ? desc.trim()
                : '';

        const imageData =
            typeof image === 'string'
                ? image
                : null;


        console.log('📥 กำลังเพิ่ม Card');
        console.log('Title:', cardTitle);
        console.log(
            'Image:',
            imageData
                ? `${imageData.length} characters`
                : 'ไม่มีรูป'
        );


        const query = `
            INSERT INTO cards
            (
                title,
                description,
                image_data
            )
            VALUES
            ($1, $2, $3)
            RETURNING *
        `;


        const result = await pool.query(
            query,
            [
                cardTitle,
                cardDescription,
                imageData
            ]
        );


        console.log(
            '✅ เพิ่ม Card สำเร็จ ID:',
            result.rows[0].id
        );


        res.status(201).json({

            success: true,

            message: 'เพิ่มการ์ดสำเร็จ',

            card: result.rows[0]

        });


    } catch (error) {

        console.error(
            '❌ ADD CARD ERROR:',
            error
        );

        res.status(500).json({

            success: false,

            message: 'ไม่สามารถเพิ่มการ์ดได้',

            error: error.message

        });

    }

});


// --------------------------------------------------
// PUT /api/cards/:id
// --------------------------------------------------

app.put(`${apiPrefix}/cards/:id`, async (req, res) => {

    try {

        const { id } = req.params;

        const {
            title,
            desc,
            image
        } = req.body;


        if (!title || title.trim() === '') {

            return res.status(400).json({

                success: false,

                message: 'กรุณากรอกหัวข้อการ์ด'

            });

        }


        const query = `
            UPDATE cards
            SET
                title = $1,
                description = $2,
                image_data = $3
            WHERE id = $4
            RETURNING *
        `;


        const result = await pool.query(
            query,
            [
                title.trim(),
                desc || '',
                image || null,
                id
            ]
        );


        if (result.rows.length === 0) {

            return res.status(404).json({

                success: false,

                message: 'ไม่พบการ์ดที่ต้องการแก้ไข'

            });

        }


        res.json({

            success: true,

            message: 'แก้ไขการ์ดสำเร็จ',

            card: result.rows[0]

        });


    } catch (error) {

        console.error(
            'UPDATE CARD ERROR:',
            error
        );

        res.status(500).json({

            success: false,

            message: 'ไม่สามารถแก้ไขการ์ดได้',

            error: error.message

        });

    }

});


// --------------------------------------------------
// DELETE /api/cards/:id
// --------------------------------------------------

app.delete(`${apiPrefix}/cards/:id`, async (req, res) => {

    try {

        const { id } = req.params;


        const result = await pool.query(
            `
            DELETE FROM cards
            WHERE id = $1
            RETURNING *
            `,
            [id]
        );


        if (result.rows.length === 0) {

            return res.status(404).json({

                success: false,

                message: 'ไม่พบการ์ดที่ต้องการลบ'

            });

        }


        res.json({

            success: true,

            message: 'ลบการ์ดสำเร็จ'

        });


    } catch (error) {

        console.error(
            'DELETE CARD ERROR:',
            error
        );

        res.status(500).json({

            success: false,

            message: 'ไม่สามารถลบการ์ดได้',

            error: error.message

        });

    }

});

// =====================================================
// API: ตรวจสอบสลิปโอนเงินจริง (SlipOK API)
// =====================================================
app.post(`${apiPrefix}/verify-slip`, async (req, res) => {
    const { image_data } = req.body;
    const apiKey = process.env.SLIP_OK_API_KEY;
    const branchId = process.env.SLIPOK_BRANCH_ID;

    if (!image_data) {
        return res.status(400).json({ success: false, message: 'กรุณาอัปโหลดรูปภาพสลิป' });
    }

    if (!apiKey || !branchId) {
        return res.status(500).json({ 
            success: false, 
            message: 'ยังไม่ได้ตั้งค่า SLIP_OK_API_KEY หรือ SLIPOK_BRANCH_ID ใน .env' 
        });
    }

    try {
        const matches = image_data.match(/^data:(.+);base64,(.+)$/);
        const mimeType = matches ? matches[1] : 'image/jpeg';
        const base64Data = matches ? matches[2] : image_data;
        const buffer = Buffer.from(base64Data, 'base64');

        const formData = new FormData();
        const blob = new Blob([buffer], { type: mimeType });
        formData.append('files', blob, 'slip.jpg');

        const response = await fetch(`https://api.slipok.com/api/line/apikey/${branchId}`, {
            method: 'POST',
            headers: { 'x-authorization': apiKey },
            body: formData
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            return res.status(400).json({
                success: false,
                message: result.message || 'สลิปไม่ถูกต้อง ปลอมแปลง หรือถูกใช้ซ้ำแล้ว',
                data: result.data || null
            });
        }

        // ✅ เพิ่มส่วนนี้: แจ้งเตือนผ่าน LINE ให้เจ้าของหอ (Admin)
        const adminLineId = process.env.ADMIN_LINE_ID;
        if (adminLineId) {
            const data = result.data;
            const senderName = data.sender?.displayName || 'ไม่ระบุชื่อ';
            const adminNotifyText = `📢 มีการแนบสลิปผ่านระบบเว็บ!\nผู้โอน: ${senderName}\nยอดเงิน: ${data.amount} บาท\n\n✅ สลิปถูกต้อง (ตรวจสอบโดย SlipOK)\nฝากเจ้าของหอยืนยันความถูกต้องอีกครั้งครับ`;
            
            await fetch('https://api.line.me/v2/bot/message/push', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                },
                body: JSON.stringify({
                    to: adminLineId,
                    messages: [{ type: 'text', text: adminNotifyText }]
                })
            }).catch(err => console.error('Failed to notify admin:', err));
        }

        res.json({
            success: true,
            message: '✅ สลิปถูกต้องและตรวจสอบสำเร็จ แจ้งเตือนเจ้าของหอแล้ว',
            data: result.data
        });

    } catch (error) {
        console.error('SlipOK API Error:', error);
        res.status(500).json({
            success: false,
            message: 'เกิดข้อผิดพลาดในการเชื่อมต่อกับบริการ SlipOK',
            error: error.message
        });
    }
});

// =====================================================
// API: ระบบ OCR บัตรประชาชน (ใช้งาน OCR.space API)
// =====================================================
app.post(`${apiPrefix}/ocr`, async (req, res) => {
    const { image_data } = req.body;
    const ocrApiKey = process.env.OCR_API_KEY;

    if (!image_data) {
        return res.status(400).json({ success: false, message: 'กรุณาอัปโหลดรูปภาพ' });
    }

    if (!ocrApiKey) {
        return res.status(500).json({ success: false, message: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า OCR_API_KEY ใน .env' });
    }

    try {
        // จัดเตรียมข้อมูลส่งแบบ Form URL Encoded
        const formData = new URLSearchParams();
        formData.append('apikey', ocrApiKey);
        formData.append('base64Image', image_data); // รองรับ Data URI (data:image/jpeg;base64,...)
        formData.append('language', 'tha');          // กำหนดภาษาไทย
        formData.append('OCREngine', '2');           // Engine 2 เหมาะกับภาษาไทยและตัวอักษรเอเชีย
        formData.append('isTable', 'false');

        // เรียกใช้งาน OCR.space API
        const response = await fetch('https://api.ocr.space/parse/image', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData
        });

        const result = await response.json();

        // ตรวจสอบข้อผิดพลาดจากฝั่ง OCR.space
        if (result.IsErroredOnProcessing) {
            const errorMessage = Array.isArray(result.ErrorMessage)
                ? result.ErrorMessage.join(', ')
                : 'ประมวลผลรูปภาพล้มเหลว';
            return res.status(400).json({ success: false, message: errorMessage });
        }

        // ข้อความที่สแกนได้ทั้งหมด
        const parsedText = result.ParsedResults?.[0]?.ParsedText || '';

        // 1. Regex ค้นหาเลขบัตรประชาชน 13 หลัก (รองรับแบบมีขีด หรือเว้นวรรค)
        const idMatch = parsedText.match(/\b\d{1}[\s-]?\d{4}[\s-]?\d{5}[\s-]?\d{2}[\s-]?\d{1}\b/);
        const rawIdCard = idMatch ? idMatch[0].replace(/[\s-]/g, '') : '';
        
        // จัดรูปแบบเลขบัตรให้อยู่ในฟอร์ม x-xxxx-xxxxx-xx-x
        const formattedIdCard = rawIdCard.length === 13
            ? `${rawIdCard[0]}-${rawIdCard.slice(1,5)}-${rawIdCard.slice(5,10)}-${rawIdCard.slice(10,12)}-${rawIdCard[12]}`
            : (idMatch ? idMatch[0] : 'ไม่พบเลขบัตรประชาชน');

        // 2. Regex ค้นหาชื่อ-นามสกุลไทย (จับคำนำหน้า นาย/นาง/นางสาว/ด.ช./ด.ญ.)
        const nameMatch = parsedText.match(/(นาย|นาง|นางสาว|เด็กชาย|เด็กหญิง|ด\.ช\.|ด\.ญ\.)\s*([ก-๙]+)\s+([ก-๙]+)/);
        const extractedName = nameMatch 
            ? `${nameMatch[1]}${nameMatch[2]} ${nameMatch[3]}` 
            : 'ไม่พบชื่อ-นามสกุล';

        // 3. Regex ค้นหาที่อยู่ (จับข้อความตั้งแต่ตัวเลขที่อยู่ จนถึงคำว่าจังหวัด/กทม.)
        const addressMatch = parsedText.match(/([0-9]+\/?[0-9]*\s*(?:หมู่ที่|หมู่|ม\.)?.*?(?:จังหวัด|กรุงเทพมหานคร)[^\s]+)/s);
        let extractedAddress = addressMatch ? addressMatch[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : '';
        
        // กรณีไม่เจอด้วยแพทเทิร์นแรก ลองหาคำว่า "ที่อยู่"
        if (!extractedAddress) {
            const altAddressMatch = parsedText.match(/ที่อยู่\s*(.*?)(?:วันออกบัตร|วันบัตร|ศาสนา|Date)/s);
            if (altAddressMatch) extractedAddress = altAddressMatch[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        }
        // 👇 เพิ่มโค้ดส่วนนี้เพื่อลบข้อความขยะ (Noise) ออกจากที่อยู่
        if (extractedAddress) {
            extractedAddress = extractedAddress
                .replace(/150\.?\s*150\s*14B\s*140/gi, '') // ลบกลุ่มตัวเลข 150 150 14B 140
                .replace(/\d{1,2}\s*[ก-๙a-zA-Z\.]+\s*\d{4}/g, '') // ลบรูปแบบวันที่ เช่น 20 สี.ค. 2561
                .replace(/ร้อยตำรวจ[^\s]*/g, '') // ลบคำว่า ร้อยตำรวจ
                .replace(/\s+/g, ' ') // เคลียร์ช่องว่างส่วนเกินที่เกิดจากการลบคำ
                .trim();
        }

        res.json({
            success: true,
            message: 'อ่านข้อมูลจากบัตรประชาชนสำเร็จ',
            data: {
                name: extractedName,
                id_card: formattedIdCard,
                address: extractedAddress,
                raw_text: parsedText // คืนค่าข้อความดิบไว้สำหรับตรวจสอบหรือ Debug
            }
        });

    } catch (error) {
        console.error('OCR.space Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'เกิดข้อผิดพลาดในการเชื่อมต่อบริการ OCR', 
            error: error.message 
        });
    }
});
/*
|--------------------------------------------------------------------------
| 404 API
|--------------------------------------------------------------------------
*/

app.use('/api', (req, res) => {

    res.status(404).json({

        success: false,

        message: 'API endpoint not found'

    });

});


/*
|--------------------------------------------------------------------------
| Global Error Handler
|--------------------------------------------------------------------------
*/

app.use((err, req, res, next) => {

    console.error('GLOBAL ERROR:', err);

    res.status(500).json({

        success: false,

        message: 'เกิดข้อผิดพลาดที่ Server',

        error: err.message

    });

});

// =====================================================
// API: ระบบแจ้งซ่อม (Repair)
// =====================================================
let mockRepairs = [
    { id: 1, room_number: '101', issue: 'แอร์ไม่เย็น มีน้ำหยด', status: 'Pending' },
    { id: 2, room_number: '204', issue: 'หลอดไฟห้องน้ำเสีย', status: 'Completed' }
];

app.get(`${apiPrefix}/repairs`, (req, res) => {
    res.json({ success: true, repairs: mockRepairs });
});

app.put(`${apiPrefix}/repairs/:id`, (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    mockRepairs = mockRepairs.map(r => r.id == id ? { ...r, status } : r);
    res.json({ success: true, message: 'อัปเดตสถานะการซ่อมสำเร็จ' });
});


// =====================================================
// API: ระบบพัสดุ (Parcel)
// =====================================================
let mockParcels = [
    { id: 1, room_number: '102', tracking_no: 'TH12345678', carrier: 'Flash Express', status: 'Waiting' }
];

app.get(`${apiPrefix}/parcels`, (req, res) => {
    res.json({ success: true, parcels: mockParcels });
});

app.post(`${apiPrefix}/parcels`, (req, res) => {
    const { room_number, tracking_no, carrier } = req.body;
    const newParcel = { id: Date.now(), room_number, tracking_no, carrier, status: 'Waiting' };
    mockParcels.unshift(newParcel);
    res.json({ success: true, message: 'บันทึกพัสดุสำเร็จและแจ้งเตือนไปยังแอปผู้เช่าแล้ว' });
});

app.put(`${apiPrefix}/parcels/:id`, (req, res) => {
    const { id } = req.params;
    mockParcels = mockParcels.map(p => p.id == id ? { ...p, status: 'PickedUp' } : p);
    res.json({ success: true, message: 'บันทึกการรับพัสดุเรียบร้อย' });
});


// =====================================================
// API: ข่าวสารและประกาศ (Announcements)
// =====================================================
let mockAnnouncements = [
    { id: 1, title: 'แจ้งปิดน้ำประปาชั่วคราว', content: 'วันจันทร์นี้ เวลา 10:00 - 14:00 น. จะมีการซ่อมแซมท่อประปาหลัก', created_at: new Date() }
];

app.get(`${apiPrefix}/announcements`, (req, res) => {
    res.json({ success: true, announcements: mockAnnouncements });
});

app.post(`${apiPrefix}/announcements`, (req, res) => {
    const { title, content } = req.body;
    mockAnnouncements.unshift({ id: Date.now(), title, content, created_at: new Date() });
    res.json({ success: true, message: 'โพสต์ประกาศสำเร็จ' });
});


// =====================================================
// API: เซ็นสัญญาออนไลน์ (Contracts)
// =====================================================
let mockContracts = [
    { id: 1, room_number: '305', tenant_name: 'คุณสมชาย ใจดี', status: 'Pending' }
];

app.get(`${apiPrefix}/contracts`, (req, res) => {
    res.json({ success: true, contracts: mockContracts });
});

app.post(`${apiPrefix}/contracts/:id/sign`, (req, res) => {
    const { id } = req.params;
    mockContracts = mockContracts.map(c => c.id == id ? { ...c, status: 'Signed' } : c);
    res.json({ success: true, message: 'ลงลายมือชื่อออนไลน์สมบูรณ์' });
});


/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {

    console.log('');
    console.log('======================================');
    console.log('🚀 DormMaster Backend Server');
    console.log('======================================');
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`📦 API: http://localhost:${PORT}/api`);
    console.log('======================================');
    console.log('');

});