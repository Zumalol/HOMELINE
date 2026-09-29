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
                    // 1. ค้นหาห้องจาก line_id ของผู้เช่า โดยอ้างอิงผ่านชื่อ tenant ในตาราง rooms
                    const roomRes = await pool.query(`
                        SELECT r.* 
                        FROM rooms r
                        JOIN tenants t ON r.tenant = t.name
                        WHERE t.line_id = $1
                    `, [userId]); //[cite: 31]

                    // กรณีไม่พบข้อมูลห้องพักที่ผูกกับบัญชี LINE นี้
                    if (roomRes.rows.length === 0) {
                        await fetch('https://api.line.me/v2/bot/message/reply', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` //[cite: 31]
                            },
                            body: JSON.stringify({
                                replyToken: event.replyToken,
                                messages: [{ type: 'text', text: '❌ ไม่พบข้อมูลห้องพักที่ผูกกับบัญชี LINE ของคุณครับ กรุณาติดต่อแอดมิน' }]
                            })
                        });
                        return;
                    }

                    const room = roomRes.rows[0];

                    // 2. ตรวจสอบสถานะการชำระเงินของห้อง
                    if (room.payment_status !== 'ค้างชำระ') { //[cite: 31]
                        await fetch('https://api.line.me/v2/bot/message/reply', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` //[cite: 31]
                            },
                            body: JSON.stringify({
                                replyToken: event.replyToken,
                                messages: [{ type: 'text', text: `✅ ห้อง ${room.number} ของคุณไม่มียอดค้างชำระในระบบครับ` }]
                            })
                        });
                        return;
                    }

                    // 3. ค้นหาไฟล์บิลของห้องนี้ในโฟลเดอร์ exports
                    const exportDir = path.join(__dirname, 'public', 'exports'); //[cite: 31]
                    let unPaidBills = [];
                    
                    if (fs.existsSync(exportDir)) {
                        const files = fs.readdirSync(exportDir);
                        // กรองเฉพาะไฟล์รูปภาพ (png/jpg) ที่ชื่อขึ้นต้นด้วย "Bill_Room_{เลขห้อง}_"
                        unPaidBills = files.filter(file => 
                            file.startsWith(`Bill_Room_${room.number}_`) && 
                            (file.endsWith('.png') || file.endsWith('.jpg')) //[cite: 31]
                        );
                    }

                    if (unPaidBills.length === 0) {
                        await fetch('https://api.line.me/v2/bot/message/reply', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                            },
                            body: JSON.stringify({
                                replyToken: event.replyToken,
                                messages: [{ type: 'text', text: `⚠️ ห้อง ${room.number} มีสถานะค้างชำระ แต่ไม่พบไฟล์บิลในระบบ กรุณาติดต่อแอดมินครับ` }]
                            })
                        });
                        return;
                    }

                    // 4. สร้างการ์ด Flex Message (Carousel) แสดงบิลค้างชำระทั้งหมด
                    const host = req.get('host');
                    const flexContents = unPaidBills.map(billFile => {
                        let fileUrl = `https://${host}/exports/${billFile}`; //[cite: 31]
                        
                        return {
                            type: "bubble",
                            size: "mega",
                            header: {
                                type: "box",
                                layout: "vertical",
                                backgroundColor: "#ef4444", // ตกแต่งหัวการ์ดด้วยสีแดง (แจ้งเตือนค้างชำระ)
                                paddingAll: "lg",
                                contents: [
                                    { type: "text", text: `⚠️ บิลค้างชำระ ห้อง ${room.number}`, color: "#ffffff", weight: "bold", size: "lg" }
                                ]
                            },
                            hero: {
                                type: "image",
                                url: fileUrl,
                                size: "full",
                                aspectRatio: "3:4", // ปรับอัตราส่วนให้เหมาะกับรูปบิลแนวตั้ง
                                aspectMode: "fit",
                                backgroundColor: "#f9fafb",
                                action: {
                                    type: "uri",
                                    label: "ดูรูปบิลขนาดเต็ม",
                                    uri: fileUrl
                                }
                            },
                            body: {
                                type: "box",
                                layout: "vertical",
                                paddingAll: "md",
                                contents: [
                                    { type: "text", text: "สถานะ: ⏳ ค้างชำระ", color: "#ef4444", weight: "bold", size: "md", align: "center" },
                                    { type: "text", text: "หากต้องการชำระเงิน ที่ละบิลให้กดเมนู ชำระเงินทั้งหมด", color: "#6b7280", size: "sm", align: "center", margin: "md", wrap: true }
                                ]
                            }
                        };
                    });

                    // ส่ง Flex Message ตอบกลับผู้ใช้งาน
                    await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` //[cite: 31]
                        },
                        body: JSON.stringify({
                            replyToken: event.replyToken,
                            messages: [{
                                type: "flex",
                                altText: `รายการบิลค้างชำระ ห้อง ${room.number}`,
                                contents: {
                                    type: "carousel",
                                    contents: flexContents
                                }
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
                    const exportDir = path.join(__dirname, 'public', 'exports');
                    let unPaidBills = [];
                    
                    if (fs.existsSync(exportDir)) {
                        const files = fs.readdirSync(exportDir);
                        unPaidBills = files.filter(file => 
                            file.startsWith(`Bill_Room_${room.number}_`) && 
                            (file.endsWith('.png') || file.endsWith('.jpg'))
                        );
                    }

                    if (unPaidBills.length === 0) {
                        await fetch('https://api.line.me/v2/bot/message/reply', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
                            body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: 'text', text: `✅ ห้อง ${room.number} ของคุณไม่มีบิลค้างชำระในระบบครับ` }] })
                        });
                        return;
                    }

                    const host = req.get('host');
                    const flexContents = unPaidBills.map(billFile => {
                        let fileUrl = `https://${host}/exports/${billFile}`;
                        return {
                            type: "bubble",
                            size: "mega",
                            header: {
                                type: "box", layout: "vertical", backgroundColor: "#3b82f6", paddingAll: "lg",
                                contents: [{ type: "text", text: `📄 บิลห้อง ${room.number}`, color: "#ffffff", weight: "bold", size: "lg" }]
                            },
                            hero: {
                                type: "image", url: fileUrl, size: "full", aspectRatio: "3:4", aspectMode: "fit", backgroundColor: "#f9fafb",
                                action: { type: "uri", label: "ดูรูปเต็ม", uri: fileUrl }
                            },
                            body: {
                                type: "box", layout: "vertical", paddingAll: "md",
                                contents: [{ type: "text", text: "สถานะ: ⏳ ค้างชำระ", color: "#ef4444", weight: "bold", align: "center", size: "md" }]
                            },
                            footer: {
                                type: "box", layout: "vertical", paddingAll: "sm",
                                contents: [{
                                    type: "button", style: "primary", color: "#3b82f6",
                                    action: { type: "message", label: "เลือกชำระบิลนี้", text: `แจ้งชำระบิล ${billFile}` }
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
                pendingSlipBills.set(event.source.userId, billName); // บันทึกบิลที่ถูกเลือกไว้
                
                await fetch('https://api.line.me/v2/bot/message/reply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
                    body: JSON.stringify({
                        replyToken: event.replyToken,
                        messages: [{ type: 'text', text: `✅ ระบบกำลังเตรียมรับชำระบิล:\n${billName}\n\nกรุณาสแกน QR Code แล้วส่งรูปสลิปเข้ามาเพื่อยืนยันการชำระเงินของใบนี้ได้เลยครับ` }]
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
                                    const filePath = path.join(__dirname, 'public', 'exports', billName);
                                    
                                    // 1. ลบไฟล์บิลใบที่จ่ายเสร็จแล้ว
                                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 

                                    // 2. เช็คว่ายังเหลือบิลใบอื่นของห้องนี้ค้างอยู่หรือไม่
                                    const exportDir = path.join(__dirname, 'public', 'exports');
                                    let remainingBills = [];
                                    if (fs.existsSync(exportDir)) {
                                        remainingBills = fs.readdirSync(exportDir).filter(f => 
                                            f.startsWith(`Bill_Room_${room.number}_`) && 
                                            (f.endsWith('.png') || f.endsWith('.jpg'))
                                        );
                                    }

                                    // 3. ถ้าไม่เหลือบิลเลย ค่อยเปลี่ยนสถานะเป็น 'ชำระเงินแล้ว'
                                    if (remainingBills.length === 0) {
                                        await pool.query(`UPDATE rooms SET payment_status = 'ชำระเงินแล้ว' WHERE id = $1`, [room.id]);
                                    }
                                    
                                    pendingSlipBills.delete(tenantId); // ล้างความจำหลังจ่ายสำเร็จ
                                } else {
                                    // การยืนยันแบบปกติ (ถ้าไม่ได้เลือกบิล)
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
app.get(`${apiPrefix}/exported-bills`, async (req, res) => {
    const exportDir = path.join(__dirname, 'public', 'exports');
    
    // ตรวจสอบว่ามีโฟลเดอร์ exports หรือไม่
    if (!fs.existsSync(exportDir)) {
        return res.json({ success: true, files: [] });
    }
    
    try {
        // 1. ดึงสถานะการชำระเงินของทุกห้องจากฐานข้อมูลมาเตรียมไว้
        const roomsResult = await pool.query('SELECT number, payment_status FROM rooms');
        const roomStatusMap = {};
        roomsResult.rows.forEach(r => {
            roomStatusMap[r.number] = r.payment_status || 'ค้างชำระ';
        });

        // 2. อ่านไฟล์ทั้งหมดในโฟลเดอร์
        fs.readdir(exportDir, (err, files) => {
            if (err) {
                console.error('Error reading exports directory:', err);
                return res.status(500).json({ success: false, message: 'ไม่สามารถอ่านโฟลเดอร์ exports ได้' });
            }
            
            // 3. กรองเอาเฉพาะไฟล์รูปภาพ .png และ .jpg
            const imageFiles = files
                .filter(file => file.endsWith('.png') || file.endsWith('.jpg'))
                .map(file => {
                    let paymentStatus = 'ค้างชำระ';
                    
                    // สกัดเลขห้องจากชื่อไฟล์ (รูปแบบ: Bill_Room_101_169...png)
                    const match = file.match(/Bill_Room_(.+?)_\d+\.(png|jpg)$/);
                    
                    if (match && match[1]) {
                        const roomNumber = match[1];
                        // นำเลขห้องไปเทียบกับสถานะที่ดึงมาจากฐานข้อมูล
                        if (roomStatusMap[roomNumber]) {
                            paymentStatus = roomStatusMap[roomNumber];
                        }
                    }

                    return {
                        name: file,
                        url: `/exports/${file}`,
                        payment_status: paymentStatus // ส่งสถานะที่อัปเดตแล้วไปให้ Frontend
                    };
                });
                
            res.json({ success: true, files: imageFiles });
        });
    } catch (error) {
        console.error('Database Error in exported bills:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

app.delete(`${apiPrefix}/exported-bills/:filename`, (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(__dirname, 'public', 'exports', fileName);
    
    // ตรวจสอบว่ามีไฟล์อยู่จริงหรือไม่ก่อนทำการลบ
    if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error('Error deleting file:', err);
                return res.status(500).json({ success: false, message: 'ไม่สามารถลบไฟล์บิลได้' });
            }
            res.json({ success: true, message: 'ลบบิลออกจากระบบสำเร็จ' });
        });
    } else {
        res.status(404).json({ success: false, message: 'ไม่พบไฟล์บิลที่ต้องการลบ' });
    }
});
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

// ฟังก์ชันสร้าง Workbook ตามแบบฟอร์มในภาพ
// ฟังก์ชันสร้างรูปภาพบิลแทน Excel
async function createBillingImage(room, inputs, filePath) {
    const roomPrice = Number(room.price || 3000);
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
    const rawDueDate = inputs.billDueDate || inputs.bill_due_date || inputs.dueDate;
    let finePerDay = Number(inputs.finePerDay || inputs.fine_per_day) || 0;
    let fineAmount = 0;
    let overdueDays = 0;

    let dueDateText = 'ไม่ระบุ';
    if (rawDueDate) {
        const d = new Date(rawDueDate);
        if (!isNaN(d.getTime())) {
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

    if (inputs.billDueDate && finePerDay > 0) {
        const dueDate = new Date(inputs.billDueDate);
        const today = new Date();
        dueDate.setHours(0, 0, 0, 0);
        today.setHours(0, 0, 0, 0);

        if (today > dueDate) {
            overdueDays = Math.ceil((today - dueDate) / (1000 * 60 * 60 * 24));
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

    const grandTotal = roomPrice + eTotal + wTotal + optFeeTotal + fineAmount;
    const currentDate = new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });

    let qrHtml = '';
    if (inputs.payMethod === 'qr' && inputs.payQrBase64) {
        qrHtml = `<img src="${inputs.payQrBase64}" style="width: 140px; height: 140px; margin-top: 15px; border: 1px solid #ccc; padding: 5px;" />`;
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

    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox','--disable-dev-shm-usage','--single-process'] });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    const bodyHandle = await page.$('body');
    const boundingBox = await bodyHandle.boundingBox();
    await page.setViewport({ width: 880, height: Math.ceil(boundingBox.height) });

    await page.screenshot({ path: filePath, type: 'png' });
    await browser.close();
}

// =====================================================
// นำ API 2 ตัวนี้ไปแทนที่ /api/generate-bills และ /api/export-billing-excel เดิม
// =====================================================

app.post(`${apiPrefix}/generate-bills`, async (req, res) => {

    const billDueDate = req.body.billDueDate || req.body.bill_due_date || req.body.dueDate;
    const finePerDay = Number(req.body.finePerDay || req.body.fine_per_day) || 0;
    const { dormName, roomNumber, lineUserId } = req.body;

    try {
        const result = await pool.query(`
            SELECT r.*, d.name as dormitory_name 
            FROM rooms r
            JOIN dormitories d ON r.dormitory_id = d.id
            WHERE r.number = $1 AND d.name = $2 AND r.status = 'Occupied'
        `, [roomNumber, dormName]);

        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบห้องที่ระบุ หรือห้องยังไม่มีผู้เช่า' });
        
        const room = result.rows[0];

        const exportDir = path.join(__dirname, 'public', 'exports');
        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true });
        }

        const fileName = `Bill_Room_${room.number}_${Date.now()}.png`;
        const filePath = path.join(exportDir, fileName);
        
        await createBillingImage(room, req.body, filePath);

        // บันทึกสถานะบิล, วันครบกำหนด, อัตราค่าปรับ และข้อมูลบิลต้นฉบับ
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
            
            let fileUrl = `${req.protocol}://${req.get('host')}/exports/${fileName}`;
            fileUrl = fileUrl.replace("http://", "https://");

            // โครงสร้างข้อความพื้นฐาน
            let messageText = `📝 แจ้งยอดค่าใช้จ่าย ประจำเดือน: ${formattedMonth}\n🚪 ห้อง: ${room.number}\n👤 ผู้เช่า: ${room.tenant}`;

            // แสดงวันที่กำหนดชำระและค่าปรับ เฉพาะในกรณีที่มีการระบุ billDueDate เข้ามาเท่านั้น
            if (billDueDate) {
                const d = new Date(billDueDate);
                const dueDateFormatted = !isNaN(d.getTime()) 
                    ? d.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' }) 
                    : billDueDate;

                messageText += `\n📅 กำหนดชำระภายใน: ${dueDateFormatted}`;
                
                if (finePerDay > 0) {
                    messageText += `\n⚠️ ค่าปรับกรณีเกินกำหนด: ${finePerDay} บาท/วัน`;
                }
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
                // แจ้งเตือนในวันครบกำหนด (Due Date Today)
                const text = `⏰ แจ้งเตือนครบกำหนดชำระเงินวันนี้!\n🏢 ห้อง: ${room.number}\n👤 คุณ: ${room.tenant}\n\nวันนี้เป็นวันครบกำหนดชำระค่าเช่าห้องพักแล้วครับ${fineRate > 0 ? `\n⚠️ *กรณีเกินกำหนดจะมีค่าปรับ ${fineRate} บาท/วัน` : ''}\nกรุณาชำระเงินและส่งสลิปเพื่อยืนยันครับ`;
                
                await sendLinePushMessage(room.line_id, text);
            } else if (diffDays > 0 && fineRate > 0) {
                // 1. อัปเดตสลิปอัตโนมัติ (สร้างรูปบิลใหม่เพื่อรวมค่าปรับล่าสุด)
                if (room.last_bill_data) {
                    try {
                        const billData = JSON.parse(room.last_bill_data);
                        const exportDir = path.join(__dirname, 'public', 'exports');
                        
                        // ค้นหาและลบรูปบิลใบเดิมของห้องนี้ทิ้ง
                        if (fs.existsSync(exportDir)) {
                            const files = fs.readdirSync(exportDir);
                            const oldBills = files.filter(f => f.startsWith(`Bill_Room_${room.number}_`));
                            oldBills.forEach(f => fs.unlinkSync(path.join(exportDir, f)));
                        }

                        // สร้างรูปบิลใหม่ (ฟังก์ชัน createBillingImage จะเช็ก Date() ปัจจุบันและบวกค่าปรับให้อัตโนมัติ)
                        const fileName = `Bill_Room_${room.number}_${Date.now()}.png`;
                        const filePath = path.join(exportDir, fileName);
                        await createBillingImage(room, billData, filePath);
                    } catch (e) {
                        console.error(`Failed to regenerate updated bill for room ${room.number}:`, e);
                    }
                }

                // 2. แจ้งเตือนเมื่อชำระเกินกำหนด (Overdue Alert)
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