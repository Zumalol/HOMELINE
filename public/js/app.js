// =====================================================
// COMPONENT LOADER
// =====================================================

async function loadComponent(elementId, filePath) {
    try {
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`ไม่สามารถโหลด ${filePath}`);

        const html = await response.text();
        const element = document.getElementById(elementId);

        if (!element) {
            console.error(`ไม่พบ element #${elementId}`);
            return false;
        }

        element.innerHTML = html;
        return true;
    } catch (error) {
        console.error('Error loading component:', error);
        return false;
    }
}

// =====================================================
// GLOBAL CARD DATA
// =====================================================

let currentCards = [];


// =====================================================
// PAGE START
// =====================================================

document.addEventListener('DOMContentLoaded', async () => {
    await loadComponent('sidebar-container', '/components/sidebar.html');

    // อ่าน Tab ล่าสุด หากไม่มีให้ไปหน้า dashboard
    const lastTab = localStorage.getItem('activeTab') || 'dashboard';
    await switchTab(lastTab);
});
// ดึงข้อมูลกลุ่มหอพักใส่ Dropdown ในฟอร์มห้องพัก
async function fetchDormitoriesForSelect() {
    try {
        const res = await fetch('/api/dormitories');
        const data = await res.json();
        const select = document.getElementById('roomDormSelect');
        if (select && data.success) {
            select.innerHTML = '<option value="">-- เลือกกลุ่มหอพัก --</option>' + 
                data.dormitories.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('');
        }
    } catch (e) {
        console.error('Error fetching dormitories for select:', e);
    }
}

// =====================================================
// TAB SWITCH
// =====================================================

async function switchTab(tab) {
    localStorage.setItem('activeTab', tab);

    document.querySelectorAll('nav a').forEach(el => {
        el.classList.remove('bg-indigo-800');
    });

    const navItem = document.getElementById(`nav-${tab}`) || 
                    document.getElementById('nav-ocr') || 
                    document.getElementById('nav-tenants');
    if (navItem) navItem.classList.add('bg-indigo-800');

    const title = document.getElementById('page-title');

    // DASHBOARD
    if (tab === 'dashboard') {
        if (title) title.innerText = 'ภาพรวมระบบหอพัก';
        await loadComponent('main-content', '/pages/dashboard.html');
        await fetchDashboardData();
        await fetchAndRenderCards();
        await fetchDashboardRooms();
    }
    else if (tab === 'tenants' || tab === 'tenant') {
    if (title) title.innerText = 'จัดการข้อมูลผู้เช่า';
    await loadComponent('main-content', '/pages/tenants.html');
    await fetchTenants();
    }

    // สำหรับหน้า OCR (เปลี่ยนเป็นหน้าตรวจสอบบิล)
    else if (tab === 'ocr') {
        if (title) title.innerText = 'ตรวจสอบบิลที่ออกแล้ว (Exports)';
        await loadComponent('main-content', '/pages/ocr.html');
        // โหลดรายการบิลที่บันทึกไว้
        if (typeof fetchExportedBills === 'function') {
            await fetchExportedBills();
        }
    }
    // ROOMS
    else if (tab === 'rooms') {
        if (title) title.innerText = 'จัดการห้องพัก & เพิ่มข้อมูล';
        await loadComponent('main-content', '/pages/rooms.html');
        await fetchDormitories();
        await fetchDormitoriesForSelect();
        await fetchTenantsForRoomSelect();
        await fetchRoomsPage();
    }
    // BILLING
    else if (tab === 'billing') {
        if (title) title.innerText = 'ออกบิลทั้งหอในคลิกเดียว';
        await loadComponent('main-content', '/pages/billing.html');
        await fetchBillingOptions();
    }
    // SLIP
    else if (tab === 'slip') {
        if (title) title.innerText = 'ตรวจสอบสลิปธนาคารอัตโนมัติ';
        await loadComponent('main-content', '/pages/slip.html');
    }
    
    // REPAIR
    else if (tab === 'repair') {
        if (title) title.innerText = 'รายการแจ้งซ่อมจากผู้เช่า';
        await loadComponent('main-content', '/pages/repair.html');
        await fetchRepairPage();
    }
    // PARCEL
    else if (tab === 'parcel') {
        if (title) title.innerText = 'ระบบจัดการพัสดุ (แจ้งเตือนผู้เช่า)';
        await loadComponent('main-content', '/pages/parcel.html');
        if (typeof fetchParcelPage === 'function') await fetchParcelPage();
        await loadAccounts(); // เรียกโหลดการ์ดบัญชีธนาคาร
    }
    // ANNOUNCEMENT
    else if (tab === 'announcement') {
        if (title) title.innerText = 'ข่าวสารและประกาศหอพัก';
        await loadComponent('main-content', '/pages/announcement.html');
        await fetchAnnouncementPage();
    }
    // CONTRACT
    else if (tab === 'contract') {
        if (title) title.innerText = 'ระบบเซ็นสัญญาเช่าออนไลน์';
        await loadComponent('main-content', '/pages/contract.html');
        await fetchContractPage();
    }
}
let currentDormitories = [];

async function fetchDormitories() {
    try {
        const res = await fetch('/api/dormitories');
        const data = await res.json();
        if (data.success) {
            currentDormitories = data.dormitories;
            const list = document.getElementById('dormitory-list');
            if (list) {
                list.innerHTML = currentDormitories.map(d => `
                    <li class="flex justify-between items-center bg-gray-50 p-3 rounded-lg border">
                        <span class="font-medium text-gray-700">${escapeHTML(d.name)}</span>
                        <div class="space-x-2">
                            <button onclick="editDormitory(${d.id}, '${d.name}')" class="text-blue-600 hover:text-blue-800 text-sm">✏️ แก้ไข</button>
                            <button onclick="deleteDormitory(${d.id})" class="text-red-600 hover:text-red-800 text-sm">🗑️ ลบ</button>
                        </div>
                    </li>
                `).join('');
            }
        }
    } catch (e) { console.error('Fetch Dormitories Error:', e); }
}

async function addDormitory() {
    const nameInput = document.getElementById('newDormName');
    const name = nameInput.value.trim();
    if (!name) return alert('กรุณากรอกชื่อหอพัก');

    try {
        await fetch('/api/dormitories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        nameInput.value = '';
        fetchDormitories();
    } catch (e) { console.error(e); }
}

async function editDormitory(id, oldName) {
    const newName = prompt('แก้ไขชื่อหอพัก:', oldName);
    if (!newName || newName.trim() === '' || newName === oldName) return;

    try {
        await fetch(`/api/dormitories/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() })
        });
        fetchDormitories();
    } catch (e) { console.error(e); }
}

async function deleteDormitory(id) {
    if (!confirm('คุณแน่ใจหรือไม่ที่จะลบกลุ่มหอพักนี้?')) return;
    try {
        await fetch(`/api/dormitories/${id}`, { method: 'DELETE' });
        fetchDormitories();
    } catch (e) { console.error(e); }
}

// =====================================================
// DASHBOARD ROOM CARDS & FILTER
// =====================================================
let dashboardRoomsData = [];

// 1. ฟังก์ชันดึงข้อมูลห้องพักมาแสดงที่ Dashboard
async function fetchDashboardRooms() {
    const grid = document.getElementById('dashboard-room-grid');
    if (!grid) return;

    try {
        const res = await fetch('/api/rooms'); 
        const rooms = await res.json();
        
        if (res.ok) {
            dashboardRoomsData = Array.isArray(rooms) ? rooms : [];
            
            // 📌 อัปเดตตัวเลข "ห้องที่จองแล้ว"
            const bookedCount = dashboardRoomsData.filter(r => r.status === 'Booked').length;
            const dbBookedEl = document.getElementById('db-booked');
            if (dbBookedEl) dbBookedEl.innerText = `${bookedCount} ห้อง`;

            // ✅ อัปเดตตัวเลข "เตรียมย้ายออก" ขึ้นการ์ด Dashboard
            const movingOutCount = dashboardRoomsData.filter(r => r.is_moving_out === true).length;
            const dbMovingOutEl = document.getElementById('db-moving-out');
            if (dbMovingOutEl) dbMovingOutEl.innerText = `${movingOutCount} ห้อง`;

            renderDashboardRooms(dashboardRoomsData);
        }
    } catch (error) {
        console.error('Error fetching dashboard rooms:', error);
        grid.innerHTML = `<div class="col-span-full text-center py-6 text-rose-500 font-bold bg-rose-50 rounded-xl">❌ ไม่สามารถโหลดข้อมูลห้องพักได้</div>`;
    }
}

// 2. ฟังก์ชันวาดการ์ดห้องพัก (Render)
function renderDashboardRooms(rooms) {
    const grid = document.getElementById('dashboard-room-grid');
    if (!grid) return;

    if (rooms.length === 0) {
        grid.innerHTML = `<div class="col-span-full flex flex-col items-center justify-center py-12 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200">
            <div class="text-4xl mb-2 opacity-50">🏢</div>
            <p class="text-gray-500 font-bold">ไม่พบข้อมูลห้องพักที่ค้นหา</p>
        </div>`;
        return;
    }

    grid.innerHTML = rooms.map(r => {
        const isOccupied = r.status === 'Occupied';
        const isBooked = r.status === 'Booked';
        let statusColor = 'bg-orange-50 text-orange-700 border-orange-200';
        let statusDot = 'bg-orange-500';
        let statusText = 'ห้องว่าง';

        if (isOccupied) {
            statusColor = 'bg-emerald-50 text-emerald-700 border-emerald-200';
            statusDot = 'bg-emerald-500';
            statusText = 'มีผู้เช่า';
        } else if (isBooked) {
            statusColor = 'bg-blue-50 text-blue-700 border-blue-300 shadow-sm shadow-blue-100 ring-1 ring-blue-200';
            statusDot = 'bg-blue-500 animate-pulse'; 
            statusText = '📌 จองแล้ว';
        }

        const tenantName = isOccupied ? (r.tenant && r.tenant !== '-' ? r.tenant : 'ไม่ระบุชื่อ') : (isBooked ? 'รอดำเนินการ' : '-');
        
        const movingOutTag = r.is_moving_out 
            ? `<div class="mt-3 bg-rose-50 text-rose-600 px-3 py-2 rounded-xl text-xs font-bold border border-rose-200 flex items-center justify-center gap-1.5 shadow-sm">
                   <span class="animate-bounce">📦</span> คาดว่าห้องนี้เตรียมออก
               </div>` 
            : '';
            // เพิ่มการตรวจสอบและสร้างแถบสถานะการจ่ายเงิน
            let paymentTag = '';
            if (isOccupied && r.payment_status === 'ค้างชำระ') {
                paymentTag = `
                <button onclick="event.stopPropagation(); selectBillForPayment('${escapeHTML(r.number)}', '${escapeHTML(r.account_number || '')}')" class="mt-2 w-full bg-orange-50 text-orange-600 px-3 py-2 rounded-xl text-xs font-bold border border-orange-200 flex items-center justify-center gap-1.5 shadow-sm hover:bg-orange-500 hover:text-white transition-colors z-10 cursor-pointer">
                    💳 เลือกชำระบิลนี้ (ค้างชำระ)
                </button>`;
            } else if (isOccupied && r.payment_status === 'ชำระเงินแล้ว') {
                paymentTag = `<div class="mt-2 bg-emerald-50 text-emerald-600 px-3 py-2 rounded-xl text-xs font-bold border border-emerald-200 flex items-center justify-center gap-1.5 shadow-sm">
                    ✅ ชำระเงินแล้ว
                </div>`;
            }
                
        return `
            <!-- เพิ่ม onclick และ cursor-pointer เพื่อให้กดเปิด Modal รายละเอียดได้ -->
            <div onclick="showRoomDetailModal(${r.id})" class="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 hover:shadow-xl hover:border-indigo-300 transition-all duration-300 group flex flex-col justify-between transform hover:-translate-y-1 cursor-pointer">
                <div>
                    <!-- Header การ์ด -->
                    <div class="flex justify-between items-start mb-4">
                        <div class="flex items-center gap-3">
                            <div class="w-12 h-12 rounded-xl bg-gradient-to-br ${isBooked ? 'from-blue-500 to-indigo-600' : 'from-indigo-500 to-purple-600'} text-white flex items-center justify-center font-bold text-xl shadow-md">
                                ${escapeHTML(r.number)}
                            </div>
                            <div>
                                <h3 class="font-bold text-gray-800 text-lg group-hover:text-indigo-600 transition-colors">ห้อง ${escapeHTML(r.number)}</h3>
                                <p class="text-xs text-gray-500 font-medium">${escapeHTML(r.dormitory_name || 'ไม่ระบุหอพัก')}</p>
                            </div>
                        </div>
                        <span class="px-2.5 py-1 rounded-lg text-xs font-bold border flex items-center gap-1.5 ${statusColor}">
                            <span class="w-2 h-2 rounded-full ${statusDot}"></span>
                            ${statusText}
                        </span>
                    </div>
                    
                    <!-- ข้อมูลภายในห้อง -->
                    <div class="mt-2 space-y-2.5 p-3.5 bg-gray-50 rounded-xl border border-gray-100/80">
                        <div class="flex items-center justify-between text-sm">
                            <span class="text-gray-500 flex items-center gap-1.5"><span class="opacity-70">👤</span> ผู้เช่า:</span>
                            <span class="font-bold text-gray-800 truncate max-w-[120px]" title="${escapeHTML(tenantName)}">${escapeHTML(tenantName)}</span>
                        </div>
                        <div class="flex items-center justify-between text-sm">
                            <span class="text-gray-500 flex items-center gap-1.5"><span class="opacity-70">💰</span> ราคา:</span>
                            <span class="font-extrabold text-indigo-600">${Number(r.price || 0).toLocaleString()} ฿</span>
                        </div>
                        <div class="flex items-center justify-between text-sm pt-2 border-t border-gray-200/60 mt-1">
                            <span class="text-gray-500 flex items-center gap-1.5"><span class="opacity-70">🏢</span> ประเภท:</span>
                            <span class="font-medium text-gray-600 bg-white px-2 py-0.5 rounded text-xs border border-gray-200">${escapeHTML(r.type || 'Standard')}</span>
                        </div>
                    </div>
                    
                    ${movingOutTag}
                </div>
            </div>
        `;
    }).join('');
}

// ฟังก์ชันเมื่อกด "เลือกชำระบิลนี้" จากการ์ดห้องพัก
async function selectBillForPayment(roomNumber, accountNumber) {
    // 1. สลับไปหน้าแนบ/ตรวจสอบสลิป
    await switchTab('slip');

    // 2. รอนำเข้าข้อมูลห้องพัก/เลขบัญชีใส่ฟอร์มตรวจสอบสลิป
    setTimeout(() => {
        const expAccInput = document.getElementById('expectedAccount');
        const roomInput = document.getElementById('slipRoomNumber') || document.getElementById('roomNumber');

        if (expAccInput && accountNumber) {
            expAccInput.value = accountNumber;
        }
        if (roomInput && roomNumber) {
            roomInput.value = roomNumber;
        }

        // 3. เลื่อนหน้าจอไปยังจุดอัปโหลดสลิป
        const fileInput = document.getElementById('slipFile');
        if (fileInput) {
            fileInput.scrollIntoView({ behavior: 'smooth' });
            fileInput.focus();
        }
    }, 300);
}

// 3. ฟังก์ชันกรองข้อมูลสถานะและค้นหา
function filterDashboardRooms() {
    const searchKeyword = document.getElementById('dbSearchRoom').value.toLowerCase();
    const filterOption = document.getElementById('dbFilterRoom').value;

    const filtered = dashboardRoomsData.filter(r => {
        const matchSearch = (r.number || '').toLowerCase().includes(searchKeyword) || 
                            (r.tenant || '').toLowerCase().includes(searchKeyword);
        
        let matchFilter = true;
        if (filterOption !== 'all') {
            matchFilter = r.status === filterOption;
        }

        return matchSearch && matchFilter;
    });

    renderDashboardRooms(filtered);
}

// ทำให้ HTML มองเห็นฟังก์ชัน
window.filterDashboardRooms = filterDashboardRooms;

// แปลงไฟล์รูปเป็น Base64
async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function savePaymentAccount() {
    const qrFile = document.getElementById('qrImageInput').files[0];
    const payload = {
        bank_name: document.getElementById('bankName').value,
        account_number: document.getElementById('accNumber').value,
        account_name: document.getElementById('accName').value,
        phone: document.getElementById('phoneNum').value,
        qr_image: qrFile ? await fileToBase64(qrFile) : null
    };

    const res = await fetch('/api/payment-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if(res.ok) {
        alert('บันทึกสำเร็จ');
        loadAccounts();
    }
}
// =====================================================
// PAYMENT ACCOUNT MANAGEMENT 
// =====================================================

let currentAccounts = [];
let editingAccountId = null; // เก็บ ID บัญชีที่กำลังแก้ไข

// โหลดรายการบัญชีรับเงินมาแสดงในการ์ด
async function loadAccounts() {
    const container = document.getElementById('accountCardsContainer');
    if (!container) return;

    try {
        const res = await fetch('/api/payment-accounts');
        const data = await res.json();
        
        currentAccounts = Array.isArray(data) ? data : (data.accounts || data.data || []);
        
        if (currentAccounts.length === 0) {
            container.innerHTML = `
                <div class="col-span-full text-center py-10 bg-gray-50 rounded-2xl border border-dashed border-gray-200">
                    <p class="text-gray-400 font-medium">ยังไม่มีข้อมูลบัญชีรับเงิน</p>
                </div>`;
            return;
        }

        container.innerHTML = currentAccounts.map(acc => {
            const qrHtml = acc.qr_image 
                ? `<div class="mt-3 p-2 bg-gray-50 rounded-xl border border-gray-100 flex justify-center">
                    <img src="${acc.qr_image}" class="h-36 object-contain rounded-lg">
                   </div>` 
                : '';

            return `
                <div class="bg-white p-5 rounded-2xl shadow-sm border border-gray-200 hover:shadow-md transition-all flex flex-col justify-between">
                    <div>
                        <div class="flex justify-between items-start mb-3 border-b pb-2">
                            <h4 class="font-bold text-indigo-700 text-lg">${escapeHTML(acc.bank_name)}</h4>
                            <span class="text-xs bg-indigo-50 text-indigo-600 font-bold px-2.5 py-1 rounded-lg">บัญชีรับเงิน</span>
                        </div>
                        <div class="space-y-1.5 text-sm text-gray-600">
                            <p><span class="text-gray-400">เลขบัญชี/พร้อมเพย์:</span> <strong class="text-gray-900 font-mono text-base">${escapeHTML(acc.account_number)}</strong></p>
                            <p><span class="text-gray-400">ชื่อบัญชี:</span> <strong class="text-gray-800">${escapeHTML(acc.account_name)}</strong></p>
                            <p><span class="text-gray-400">เบอร์ติดต่อ:</span> ${escapeHTML(acc.phone || '-')}</p>
                        </div>
                        ${qrHtml}
                    </div>
                    <div class="mt-4 flex gap-2 w-full">
                        <button onclick="editAccount(${acc.id})" class="flex-1 py-2 bg-blue-50 hover:bg-blue-100 text-blue-600 text-xs font-bold rounded-xl transition-colors">
                            ✏️ แก้ไข
                        </button>
                        <button onclick="deleteAccount(${acc.id})" class="flex-1 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 text-xs font-bold rounded-xl transition-colors">
                            🗑 ลบ
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Error loading accounts:', e);
    }
}

// ฟังก์ชันดึงข้อมูลบัญชีเดิมมาใส่ฟอร์มเพื่อแก้ไข
function editAccount(id) {
    const acc = currentAccounts.find(a => Number(a.id) === Number(id));
    if (!acc) return alert('ไม่พบข้อมูลบัญชีที่ต้องการแก้ไข');

    editingAccountId = acc.id;

    // เติมข้อมูลลงฟอร์ม
    if (document.getElementById('bankName')) document.getElementById('bankName').value = acc.bank_name || '';
    if (document.getElementById('accNumber')) document.getElementById('accNumber').value = acc.account_number || '';
    if (document.getElementById('accName')) document.getElementById('accName').value = acc.account_name || '';
    if (document.getElementById('phoneNum')) document.getElementById('phoneNum').value = acc.phone || '';

    // เปลี่ยนข้อความปุ่มบันทึก (ถ้ามี id="saveAccountBtn")
    const saveBtn = document.getElementById('saveAccountBtn');
    if (saveBtn) saveBtn.innerText = '💾 บันทึกการแก้ไข';

    // เลื่อนหน้าจอไปยังฟอร์มแก้ไข
    const formElement = document.getElementById('bankName')?.closest('form') || document.getElementById('bankName')?.closest('div');
    if (formElement) {
        formElement.scrollIntoView({ behavior: 'smooth' });
    }
}

// ฟังก์ชันบันทึกข้อมูลบัญชี (รองรับทั้ง เพิ่มใหม่ POST และ แก้ไข PUT)
async function savePaymentAccount() {
    const qrFile = document.getElementById('qrImageInput')?.files[0];
    const bank_name = document.getElementById('bankName')?.value.trim();
    const account_number = document.getElementById('accNumber')?.value.trim();
    const account_name = document.getElementById('accName')?.value.trim();
    const phone = document.getElementById('phoneNum')?.value.trim();

    if (!bank_name || !account_number || !account_name) {
        return alert('กรุณากรอกชื่อธนาคาร เลขบัญชี และชื่อบัญชีให้ครบถ้วน');
    }

    let qr_image = null;
    if (qrFile) {
        qr_image = await fileToBase64(qrFile);
    } else if (editingAccountId) {
        // กรณีแก้ไขแต่ไม่ได้อัปโหลดรูปใหม่ ให้ใช้รูปเดิม
        const existingAcc = currentAccounts.find(a => Number(a.id) === Number(editingAccountId));
        qr_image = existingAcc ? existingAcc.qr_image : null;
    }

    const payload = { bank_name, account_number, account_name, phone, qr_image };

    try {
        const url = editingAccountId ? `/api/payment-accounts/${editingAccountId}` : '/api/payment-accounts';
        const method = editingAccountId ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            alert(editingAccountId ? '✅ แก้ไขข้อมูลสำเร็จ' : '✅ บันทึกบัญชีใหม่สำเร็จ');
            resetAccountForm();
            await loadAccounts();
        } else {
            const errData = await res.json();
            alert('❌ เกิดข้อผิดพลาด: ' + (errData.message || 'ไม่สามารถบันทึกได้'));
        }
    } catch (e) {
        console.error('Save Account Error:', e);
        alert('❌ เกิดข้อผิดพลาดในการเชื่อมต่อระบบ');
    }
}

// ล้างค่าฟอร์มบัญชีรับเงิน
function resetAccountForm() {
    editingAccountId = null;
    if (document.getElementById('bankName')) document.getElementById('bankName').value = '';
    if (document.getElementById('accNumber')) document.getElementById('accNumber').value = '';
    if (document.getElementById('accName')) document.getElementById('accName').value = '';
    if (document.getElementById('phoneNum')) document.getElementById('phoneNum').value = '';
    if (document.getElementById('qrImageInput')) document.getElementById('qrImageInput').value = '';

    const saveBtn = document.getElementById('saveAccountBtn');
    if (saveBtn) saveBtn.innerText = '➕ เพิ่มบัญชีรับเงิน';
}

// ฟังก์ชันลบบัญชีรับเงิน
async function deleteAccount(id) {
    if (!confirm('คุณแน่ใจหรือไม่ที่จะลบบัญชีรับเงินนี้?')) return;
    try {
        const res = await fetch(`/api/payment-accounts/${id}`, { method: 'DELETE' });
        if (res.ok) {
            alert('✅ ลบบัญชีสำเร็จ');
            await loadAccounts();
        } else {
            alert('❌ ไม่สามารถลบบัญชีได้');
        }
    } catch (e) {
        console.error('Delete Account Error:', e);
        alert('❌ เกิดข้อผิดพลาดในการลบบัญชี');
    }
}

// โหลดบัญชีรับเงินเข้า Dropdown ในหน้า Billing
async function loadPaymentOptionsForBilling() {
    const select = document.getElementById('paymentAccountSelect');
    if (!select) return;

    try {
        const res = await fetch('/api/payment-accounts');
        const data = await res.json();
        
        select.innerHTML = '<option value="">-- ดึงข้อมูลจากบัญชีที่บันทึกไว้ --</option>';
        
        // รองรับทั้งกรณี data เป็น Array โดยตรง หรือซ้อนอยู่ใน accounts / data
        const accounts = Array.isArray(data) ? data : (data.accounts || data.data || []);
        
        if (accounts.length > 0) {
            accounts.forEach(acc => {
                const option = document.createElement('option');
                option.value = JSON.stringify(acc);
                option.textContent = `🏦 ${acc.bank_name} - ${acc.account_name} (${acc.account_number})`;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading payment options:', error);
    }
}
// ฟังก์ชันล้างค่าฟอร์มบัญชีรับเงินในการออกบิล
function resetBillingPaymentForm() {
    const select = document.getElementById('paymentAccountSelect');
    if (select) select.value = '';

    if (document.getElementById('payBank')) document.getElementById('payBank').value = '';
    if (document.getElementById('payAccountNo')) document.getElementById('payAccountNo').value = '';
    if (document.getElementById('payName')) document.getElementById('payName').value = '';
    if (document.getElementById('payPhone')) document.getElementById('payPhone').value = '';
    if (document.getElementById('payQrBase64')) document.getElementById('payQrBase64').value = '';
    if (document.getElementById('payQrImage')) document.getElementById('payQrImage').value = '';

    const payMethod = document.getElementById('payMethod');
    if (payMethod) {
        payMethod.value = 'account';
        togglePayMethod();
    }
}

// ฟังก์ชันเลือกบัญชีให้อัตโนมัติหากห้องพักมีเลขบัญชีผูกไว้
function autoSelectPaymentAccountByNumber(accNumber) {
    const select = document.getElementById('paymentAccountSelect');
    if (!select || !accNumber) return;

    for (let i = 0; i < select.options.length; i++) {
        const opt = select.options[i];
        if (!opt.value) continue;
        try {
            const acc = JSON.parse(opt.value);
            if (acc.account_number === accNumber) {
                select.selectedIndex = i;
                onSelectSavedPaymentAccount(select);
                break;
            }
        } catch (e) {}
    }
}

// เมื่อเลือกบัญชีจาก Dropdown ให้เติมข้อมูลลงฟอร์มอัตโนมัติ
function onSelectSavedPaymentAccount(selectEl) {
    if (!selectEl || !selectEl.value) {
        resetBillingPaymentForm();
        return;
    }
    
    const acc = JSON.parse(selectEl.value);
    
    if (document.getElementById('payBank')) document.getElementById('payBank').value = acc.bank_name || '';
    if (document.getElementById('payAccountNo')) document.getElementById('payAccountNo').value = acc.account_number || '';
    if (document.getElementById('payName')) document.getElementById('payName').value = acc.account_name || '';
    if (document.getElementById('payPhone')) document.getElementById('payPhone').value = acc.phone || '';
    
    // หากมีรูป QR Code ให้เลือกโหมด QR Code อัตโนมัติ
    if (acc.qr_image) {
        if (document.getElementById('payMethod')) document.getElementById('payMethod').value = 'qr';
        if (document.getElementById('payQrBase64')) document.getElementById('payQrBase64').value = acc.qr_image;
        togglePayMethod();
    } else {
        if (document.getElementById('payMethod')) document.getElementById('payMethod').value = 'account';
        if (document.getElementById('payQrBase64')) document.getElementById('payQrBase64').value = '';
        togglePayMethod();
    }
}

// =====================================================
// EXPORTED BILLS SYSTEM (แก้ไขเรื่องวันหมดอายุและรูปภาพหาย)
// =====================================================
async function fetchExportedBills() {
    const grid = document.getElementById('bills-grid');
    if (!grid) return;
    
    grid.innerHTML = '<div class="text-center py-10 text-indigo-400 font-medium col-span-full animate-pulse">⏳ กำลังโหลดข้อมูลบิล...</div>';
    
    try {
        const res = await fetch('/api/exported-bills');
        const data = await res.json();
        
        if (!res.ok || !data.success) {
            throw new Error(data.message || 'ไม่สามารถโหลดข้อมูลบิลได้');
        }
        
        if (!data.files || data.files.length === 0) {
            grid.innerHTML = `
                <div class="col-span-full text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                    <div class="text-4xl mb-2 opacity-50">📂</div>
                    <p class="text-gray-500 font-bold">ยังไม่มีบิลที่ถูกสร้างในระบบ</p>
                </div>
            `;
            return;
        }
        
        // เรียงลำดับจากบิลใหม่ล่าสุดไปเก่าสุด
        const sortedFiles = data.files.sort((a, b) => b.name.localeCompare(a.name));
        
        grid.innerHTML = sortedFiles.map(file => {
            // 📍 แก้ไขจุดที่ 1: เปลี่ยนจาก const เป็น let เพื่อให้แก้ค่าสถานะได้โดยไม่เกิด runtime error
            let paymentStatus = file.payment_status || 'ค้างชำระ';
            let statusBadge = '';

            // 📍 แก้ไขจุดที่ 2: ปรับระบบเปรียบเทียบวันเวลาให้เสถียรและแม่นยำ (คำนวณแบบ Local Midnight)
            if (file.due_date && paymentStatus !== 'ชำระเงินแล้ว') {
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                const due = new Date(file.due_date); // เปลี่ยนจาก dueDate เป็น file.due_date
                due.setHours(0, 0, 0, 0);

                // หากบิลเกินกำหนด ให้เปลี่ยนสถานะสำหรับการแสดงป้าย (Badge)
                if (today > due) {
                    paymentStatus = 'เกินกำหนด'; 
                }
            }

            
            // สร้าง ป้ายสถานะ (Badge)
            if (paymentStatus === 'ชำระเงินแล้ว') {
                statusBadge = `<span class="absolute top-3 left-3 px-3 py-1.5 bg-emerald-500/95 backdrop-blur-sm text-white text-xs font-bold rounded-xl shadow-lg flex items-center gap-1.5 border border-emerald-400/50 z-10">✅ ชำระเงินแล้ว</span>`;
            } else if (paymentStatus === 'เกินกำหนด') {
                statusBadge = `<span class="absolute top-3 left-3 px-3 py-1.5 bg-rose-500/95 backdrop-blur-sm text-white text-xs font-bold rounded-xl shadow-lg flex items-center gap-1.5 border border-rose-400/50 z-10 animate-pulse">🚨 เกินกำหนดชำระ</span>`;
            } else {
                statusBadge = `<span class="absolute top-3 left-3 px-3 py-1.5 bg-orange-500/95 backdrop-blur-sm text-white text-xs font-bold rounded-xl shadow-lg flex items-center gap-1.5 border border-orange-400/50 z-10 animate-pulse">⏳ ค้างชำระ</span>`;
            }

            // 📍 แก้ไขจุดที่ 3: กำหนด Path สำรองกรณี file.url เป็น undefined
            const imgUrl = file.url || `/exports/${file.name}`;

            return `
            <div class="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-lg hover:border-indigo-200 transition-all duration-300 group flex flex-col relative">
                
                <!-- รูปภาพบิล -->
                <a href="${imgUrl}" target="_blank" class="block overflow-hidden bg-gray-50 relative h-56">
                    <img src="${imgUrl}" 
                         alt="${escapeHTML(file.name)}" 
                         onerror="this.onerror=null; this.src='https://via.placeholder.com/400x500?text=Bill+Image+Not+Found';"
                         class="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500">
                    <div class="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300"></div>
                    
                    ${statusBadge}
                </a>
                
                <div class="p-4 flex flex-col flex-1">
                    <!-- ชื่อไฟล์ -->
                    <p class="text-sm font-bold text-gray-800 truncate mb-4" title="${escapeHTML(file.name)}">
                        ${escapeHTML(file.name)}
                    </p>
                    
                    
                    <!-- กลุ่มปุ่มกด -->
                    <div class="flex gap-2 mt-auto">
                        <a href="${imgUrl}" target="_blank" class="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold bg-white border border-gray-200 text-gray-700 py-2.5 rounded-xl hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200 transition-all shadow-sm hover:shadow active:scale-95">
                            👁️ ดูรูป
                        </a>
                        
                        <a href="${imgUrl}" download class="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold bg-indigo-600 text-white py-2.5 rounded-xl hover:bg-indigo-700 transition-all shadow-sm hover:shadow-md active:scale-95">
                            ⬇️ โหลด
                        </a>
                        
                        <button onclick="deleteExportedBill('${encodeURIComponent(file.name)}')" class="flex items-center justify-center px-3.5 bg-rose-50 text-rose-600 border border-rose-100 rounded-xl hover:bg-rose-500 hover:text-white transition-all shadow-sm hover:shadow active:scale-95" title="ลบบิลนี้">
                            🗑️
                        </button>
                    </div>
                </div>
            </div>
            `;
        }).join('');
        
    } catch (error) {
        console.error('Fetch Bills Error:', error);
        grid.innerHTML = `<div class="text-center py-10 text-rose-500 font-bold bg-rose-50 rounded-xl col-span-full">❌ ${error.message}</div>`;
    }
}

async function deleteExportedBill(encodedFilename) {
    // ถอดรหัสชื่อไฟล์กลับเป็นข้อความปกติเพื่อใช้แสดงในหน้าต่าง Confirm
    const filename = decodeURIComponent(encodedFilename);

    if (!confirm(`คุณแน่ใจหรือไม่ที่จะลบบิล ${filename}? \n(การลบไฟล์นี้ไม่สามารถกู้คืนได้)`)) {
        return;
    }

    try {
        const res = await fetch(`/api/exported-bills/${encodedFilename}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            // แนบชื่อไฟล์ไปใน Body ด้วย เพื่อป้องกันปัญหากรณี Backend ถอดรหัส URL ภาษาไทยไม่สำเร็จ
            body: JSON.stringify({ filename: filename })
        });
        
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.message || 'เกิดข้อผิดพลาดในการลบไฟล์');
        }

        alert('✅ ' + data.message);
        
        // โหลดรายการบิลใหม่เพื่ออัปเดตหน้าจอ
        await fetchExportedBills();
        
    } catch (error) {
        console.error('Delete Bill Error:', error);
        alert('❌ ' + error.message);
    }
}

// =====================================================
// DASHBOARD
// =====================================================

async function fetchDashboardData() {

    try {

        const res =
            await fetch('/api/dashboard');


        const data =
            await res.json();


        if (!res.ok) {

            throw new Error(
                data.message ||
                data.error ||
                'Dashboard error'
            );

        }


        const total =
            document.getElementById(
                'db-total-rooms'
            );

        const occupied =
            document.getElementById(
                'db-occupied'
            );

        const vacant =
            document.getElementById(
                'db-vacant'
            );

        const revenue =
            document.getElementById(
                'db-revenue'
            );


        if (total) {

            total.innerText =
                `${data.totalRooms} ห้อง`;

        }


        if (occupied) {

            occupied.innerText =
                `${data.occupiedRooms} ห้อง`;

        }


        if (vacant) {

            vacant.innerText =
                `${data.vacantRooms} ห้อง`;

        }


        if (revenue) {

            revenue.innerText =
                `${Number(
                    data.totalRevenue || 0
                ).toLocaleString()} ฿`;

        }


    } catch (error) {

        console.error(
            'Dashboard Error:',
            error
        );

    }

}
// =====================================================
// DASHBOARD & DORMITORY STATS
// =====================================================

// 1. ฟังก์ชันดึงข้อมูลภาพรวมและสถิติตามกลุ่มหอพัก
async function fetchDashboardData() {
    try {
        const res = await fetch('/api/dashboard');
        const data = await res.json();

        if (!res.ok) throw new Error(data.message || 'Dashboard error');

        const total = document.getElementById('db-total-rooms');
        const occupied = document.getElementById('db-occupied');
        const vacant = document.getElementById('db-vacant');
        const revenue = document.getElementById('db-revenue');

        if (total) total.innerText = `${data.totalRooms || 0} ห้อง`;
        if (occupied) occupied.innerText = `${data.occupiedRooms || 0} ห้อง`;
        if (vacant) vacant.innerText = `${data.vacantRooms || 0} ห้อง`;
        if (revenue) revenue.innerText = `${Number(data.totalRevenue || 0).toLocaleString()} ฿`;

        // ✅ เรียกฟังก์ชันเพื่อวาดการ์ดสรุปแยกตามกลุ่มหอพัก และอัปเดตตัวกรอง
        if (data.dormStats) {
            renderDormitoryStats(data.dormStats);
            populateDormFilterSelect(data.dormStats);
        }

    } catch (error) {
        console.error('Dashboard Error:', error);
    }
}


// โหลดตัวเลือกกลุ่มหอพักสำหรับฟิลเตอร์ตาราง
async function fetchDormitoriesForTableFilter() {
    try {
        const res = await fetch('/api/dormitories');
        const data = await res.json();
        const select = document.getElementById('tableDormFilter');
        if (select && data.success) {
            select.innerHTML = '<option value="all">🏢 ทุกกลุ่มหอพัก</option>' + 
                data.dormitories.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('');
        }
    } catch (e) {
        console.error('Error fetching dormitories for filter:', e);
    }
}

function changeRoomsPage(newPage) {
    const totalPages = Math.ceil(filteredRooms.length / itemsPerPage) || 1;
    if (newPage >= 1 && newPage <= totalPages) {
        currentPage = newPage;
        renderRoomsTable();
    }
}

// ฟังก์ชันวาดการ์ดสถิติตามกลุ่มหอพัก
function renderDormitoryStats(dormStats) {
    const grid = document.getElementById('dormitory-stats-grid');
    if (!grid) return;

    if (!dormStats || dormStats.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center py-6 text-gray-400 bg-gray-50 rounded-xl">ยังไม่มีกลุ่มหอพักในระบบ</div>`;
        return;
    }

    grid.innerHTML = dormStats.map(dorm => {
        // คำนวณอัตราการครองห้อง (%)
        const occRate = dorm.totalRooms > 0 ? Math.round((dorm.occupiedRooms / dorm.totalRooms) * 100) : 0;

        return `
            <div class="bg-gradient-to-br from-slate-50 to-indigo-50/40 p-5 rounded-2xl border border-indigo-100 shadow-sm hover:shadow-md transition-all duration-300">
                <div class="flex justify-between items-center mb-3">
                    <h3 class="font-bold text-gray-800 text-base flex items-center gap-2">
                        <span class="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-sm">
                            🏢
                        </span>
                        ${escapeHTML(dorm.name)}
                    </h3>
                    <span class="text-xs font-extrabold px-2.5 py-1 bg-indigo-100 text-indigo-700 rounded-full">
                        ${occRate}% เต็ม
                    </span>
                </div>

                <!-- Progress Bar เปอร์เซ็นต์ผู้เช่า -->
                <div class="w-full bg-gray-200 rounded-full h-2 mb-4 overflow-hidden">
                    <div class="bg-indigo-600 h-2 rounded-full transition-all duration-500" style="width: ${occRate}%"></div>
                </div>

                <!-- สถิติ 4 ช่องหลัก -->
                <div class="grid grid-cols-2 gap-2 text-xs">
                    <div class="bg-white p-2.5 rounded-xl border border-gray-100 shadow-2xs">
                        <span class="text-gray-400 block mb-0.5">ห้องทั้งหมด</span>
                        <span class="font-extrabold text-gray-800 text-sm">${dorm.totalRooms} ห้อง</span>
                    </div>
                    <div class="bg-white p-2.5 rounded-xl border border-gray-100 shadow-2xs">
                        <span class="text-emerald-500 font-medium block mb-0.5">🟢 มีผู้เช่าแล้ว</span>
                        <span class="font-extrabold text-emerald-700 text-sm">${dorm.occupiedRooms} ห้อง</span>
                    </div>
                    <div class="bg-white p-2.5 rounded-xl border border-gray-100 shadow-2xs">
                        <span class="text-amber-500 font-medium block mb-0.5">🟠 ห้องว่าง</span>
                        <span class="font-extrabold text-orange-600 text-sm">${dorm.vacantRooms} ห้อง</span>
                    </div>
                    <div class="bg-white p-2.5 rounded-xl border border-gray-100 shadow-2xs">
                        <span class="text-purple-600 font-medium block mb-0.5">💰 รายรับเดือนนี้</span>
                        <span class="font-extrabold text-purple-700 text-sm">${Number(dorm.revenue || 0).toLocaleString()} ฿</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// เติมตัวเลือกใส่ Dropdown ตัวกรองกลุ่มหอพัก
function populateDormFilterSelect(dormStats) {
    const select = document.getElementById('dbFilterDorm');
    if (!select || !dormStats) return;

    const options = dormStats.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('');
    select.innerHTML = '<option value="all">🏢 ทุกกลุ่มหอพัก</option>' + options;
}

// ปรับปรุงฟังก์ชันกรองข้อมูลห้องพัก (รองรับทั้ง ค้นหา, สถานะห้อง, และกลุ่มหอพัก)
function filterDashboardRooms() {
    const searchKeyword = (document.getElementById('dbSearchRoom')?.value || '').toLowerCase();
    const filterOption = document.getElementById('dbFilterRoom')?.value || 'all';
    const dormOption = document.getElementById('dbFilterDorm')?.value || 'all';

    const filtered = dashboardRoomsData.filter(r => {
        // กรองคำค้นหา
        const matchSearch = (r.number || '').toLowerCase().includes(searchKeyword) || 
                            (r.tenant || '').toLowerCase().includes(searchKeyword);
        
        // กรองสถานะห้อง
        let matchFilter = true;
        if (filterOption !== 'all') {
            matchFilter = r.status === filterOption;
        }

        // กรองกลุ่มหอพัก
        let matchDorm = true;
        if (dormOption !== 'all') {
            if (dormOption === 'unassigned') {
                matchDorm = !r.dormitory_id;
            } else {
                matchDorm = String(r.dormitory_id) === String(dormOption);
            }
        }

        return matchSearch && matchFilter && matchDorm;
    });

    renderDashboardRooms(filtered);
}

// เปิดให้ HTML เรียกใช้งานได้
window.filterDashboardRooms = filterDashboardRooms;


// =====================================================
// ROOMS
// =====================================================

async function fetchRoomsPage() {

    try {

        const res =
            await fetch('/api/rooms');


        const rooms =
            await res.json();


        if (!res.ok) {

            throw new Error(
                rooms.message ||
                rooms.error ||
                'Rooms error'
            );

        }


        let roomRows = '';


        rooms.forEach(r => {

            roomRows += `

                <tr class="border-b hover:bg-gray-50">

                    <td class="p-3 font-semibold">
                        ${escapeHTML(r.number)}
                    </td>

                    <td class="p-3">
                        ${escapeHTML(r.type || '-')}
                    </td>

                    <td class="p-3">
                        ${Number(
                            r.price || 0
                        ).toLocaleString()} ฿
                    </td>

                    <td class="p-3">
                        <span class="px-2.5 py-1 rounded-full text-xs font-medium ${
                            r.status === 'Occupied' ? 'bg-green-100 text-green-700' : 
                            r.status === 'Booked' ? 'bg-blue-100 text-blue-800 border border-blue-200 font-bold' : 
                            'bg-orange-100 text-orange-700'
                        }">
                            ${r.status === 'Occupied' ? 'มีผู้เช่าแล้ว' : r.status === 'Booked' ? '📌 จองแล้ว' : 'ห้องว่าง'}
                        </span>
                    </td>

                    <td class="p-3">
                        ${escapeHTML(r.tenant || '-')}
                    </td>

                </tr>

            `;

        });


        const tbody =
            document.getElementById(
                'rooms-table-body'
            );


        if (tbody) {

            tbody.innerHTML =
                roomRows ||
                `
                <tr>
                    <td
                        colspan="5"
                        class="text-center p-6 text-gray-400"
                    >
                        ยังไม่มีข้อมูลห้อง
                    </td>
                </tr>
                `;

        }


    } catch (error) {

        console.error(
            'Rooms Error:',
            error
        );

    }

}

// =====================================================
// ROOM MULTIPLE IMAGES MANAGEMENT
// =====================================================
let roomImagesArray = []; // ตัวแปรเก็บชุด Base64 ของรูปภาพทั้งหมด

function previewRoomImages(event) {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    // ตั้งค่าขนาดไฟล์สูงสุดเป็น 50MB (50 * 1024 * 1024 bytes)
    const maxFileSize = 50 * 1024 * 1024; 
    
    let pending = files.length;

    files.forEach(file => {
        if (file.size > maxFileSize) {
            alert(`❌ ไฟล์ ${file.name} มีขนาดใหญ่เกิน 50MB`);
            pending--;
            return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            roomImagesArray.push(e.target.result);
            pending--;
            if (pending === 0) {
                renderRoomImagePreviews();
            }
        };
        reader.readAsDataURL(file);
    });

    // เคลียร์ค่า input file เพื่อให้กดเลือกไฟล์เพิ่มได้เรื่อยๆ
    event.target.value = '';
}

function renderRoomImagePreviews() {
    const container = document.getElementById('roomImagePreviewContainer');
    const hiddenInput = document.getElementById('roomImageData');

    if (!container || !hiddenInput) return;

    if (roomImagesArray.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        hiddenInput.value = '';
        return;
    }

    container.classList.remove('hidden');
    hiddenInput.value = JSON.stringify(roomImagesArray); // บันทึกเป็น JSON string ของ Array

    container.innerHTML = roomImagesArray.map((imgBase64, index) => `
        <div class="relative w-full h-24 bg-gray-100 rounded-xl overflow-hidden border border-gray-200 group">
            <img src="${imgBase64}" class="w-full h-full object-cover">
            <button type="button" onclick="removeRoomImage(${index})" class="absolute top-1 right-1 bg-white/90 text-red-500 hover:text-red-700 p-1.5 rounded-lg shadow-sm text-xs" title="ลบรูปนี้">
                🗑️
            </button>
        </div>
    `).join('');
}

function removeRoomImage(index) {
    roomImagesArray.splice(index, 1);
    renderRoomImagePreviews();
}

// =====================================================
// ROOM TENANT
// =====================================================


async function toggleTenantInput() {
    const status = document.getElementById('roomStatus');
    const tenantBox = document.getElementById('tenantBox');

    if (!status || !tenantBox) {
        return;
    }

    if (status.value === 'Occupied') {
        tenantBox.style.display = 'block';
        // ดึงข้อมูลรายชื่อผู้เช่ามาอัปเดตในช่อง input ทันทีที่เลือก "มีผู้เช่าแล้ว"
        await fetchTenantsForRoomSelect();
    } else {
        tenantBox.style.display = 'none';
    }
}

// เพิ่มตัวแปรเก็บข้อมูลห้องพักฝั่ง Frontend
let currentRooms = [];
let filteredRooms = [];
let currentPage = 1;
const itemsPerPage = 8;

async function fetchRoomsPage() {
    try {
        const res = await fetch('/api/rooms');
        const rooms = await res.json();

        if (!res.ok) throw new Error(rooms.message || 'Rooms error');

        currentRooms = Array.isArray(rooms) ? rooms : [];
        applyRoomFilters(); // คำนวณการกรองและแสดงผลตามหน้า
    } catch (error) {
        console.error('Rooms Error:', error);
    }
}

function applyRoomFilters() {
    const dormFilter = document.getElementById('tableDormFilter')?.value || 'all';
    const searchKeyword = (document.getElementById('tableSearchRoom')?.value || '').toLowerCase();

    filteredRooms = currentRooms.filter(r => {
        const matchDorm = dormFilter === 'all' || String(r.dormitory_id) === String(dormFilter);
        const matchSearch = (r.number || '').toLowerCase().includes(searchKeyword) || 
                            (r.tenant || '').toLowerCase().includes(searchKeyword);
        return matchDorm && matchSearch;
    });

    currentPage = 1; // รีเซ็ตกลับไปหน้าแรกเมื่อมีฟิลเตอร์ใหม่
    renderRoomsTable();
}

function renderRoomsTable() {
    const tbody = document.getElementById('rooms-table-body');
    if (!tbody) return;

    const totalPages = Math.ceil(filteredRooms.length / itemsPerPage) || 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const startIndex = (currentPage - 1) * itemsPerPage;
    const paginatedRooms = filteredRooms.slice(startIndex, startIndex + itemsPerPage);

    // หากไม่มีข้อมูล ให้แสดง colspan 8
    if (paginatedRooms.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="text-center py-8 text-gray-400 font-medium">
                    ไม่พบข้อมูลห้องพักตามเงื่อนไขที่เลือก
                </td>
            </tr>`;
        renderPaginationControls(0, 1);
        return;
    }

    tbody.innerHTML = paginatedRooms.map(r => {
        // ส่วนจัดการป้ายเตรียมออก
        const moveOutText = r.is_moving_out 
            ? `<span class="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200 shadow-sm">
                📦 ${r.move_out_day || '-'} ${r.move_out_month || ''}
               </span>`
            : `<span class="text-xs text-gray-400 font-normal">-</span>`;

        // ส่วนจัดการป้ายสถานะ
        let statusBadge = '';
        if (r.status === 'Occupied') {
            statusBadge = `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">มีผู้เช่าแล้ว</span>`;
        } else if (r.status === 'Booked') {
            statusBadge = `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800 border border-blue-200">📌 จองแล้ว</span>`;
        } else {
            statusBadge = `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-orange-100 text-orange-700">ว่าง</span>`;
        }

        return `
            <tr class="border-b border-gray-100 hover:bg-indigo-50/30 transition-colors">
                <td class="p-3.5 font-bold text-gray-800">${escapeHTML(r.number)}</td>
                <td class="p-3.5 text-sm text-gray-600">${escapeHTML(r.dormitory_name || 'ไม่ระบุ')}</td>
                <td class="p-3.5 text-sm text-gray-600">${escapeHTML(r.type || '-')}</td>
                <td class="p-3.5 font-extrabold text-indigo-600">${Number(r.price || 0).toLocaleString()} ฿</td>
                <td class="p-3.5">${statusBadge}</td>
                <td class="p-3.5 text-center">${moveOutText}</td>
                <td class="p-3.5 text-sm font-medium text-gray-700">${escapeHTML(r.tenant || '-')}</td>
                <td class="p-3.5 text-center space-x-2">
                    <button onclick="editRoom(${r.id})" class="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="แก้ไข">✏️</button>
                    <button onclick="deleteRoom(${r.id})" class="p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="ลบ">🗑️</button>
                </td>
            </tr>
        `;
    }).join('');

    renderPaginationControls(filteredRooms.length, totalPages);
}

function renderPaginationControls(totalItems, totalPages) {
    const container = document.getElementById('rooms-pagination');
    if (!container) return;

    container.innerHTML = `
        <div class="flex flex-col sm:flex-row justify-between items-center gap-3 pt-4 text-sm text-gray-500 border-t border-gray-100 w-full">
            <div>
                แสดง <span class="font-bold text-gray-800">${totalItems === 0 ? 0 : (currentPage - 1) * itemsPerPage + 1}</span> 
                ถึง <span class="font-bold text-gray-800">${Math.min(currentPage * itemsPerPage, totalItems)}</span> 
                จากทั้งหมด <span class="font-bold text-gray-800">${totalItems}</span> รายการ
            </div>
            <div class="flex items-center gap-1.5">
                <button onclick="changeRoomsPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled class="px-3 py-1.5 rounded-lg border bg-gray-50 text-gray-300 cursor-not-allowed"' : 'class="px-3 py-1.5 rounded-lg border bg-white text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 transition-all font-medium shadow-xs"'}>
                    👈 ก่อนหน้า
                </button>
                <span class="px-3 py-1.5 font-bold text-indigo-600 bg-indigo-50 rounded-lg border border-indigo-100">
                    ${currentPage} / ${totalPages}
                </span>
                <button onclick="changeRoomsPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled class="px-3 py-1.5 rounded-lg border bg-gray-50 text-gray-300 cursor-not-allowed"' : 'class="px-3 py-1.5 rounded-lg border bg-white text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 transition-all font-medium shadow-xs"'}>
                    ถัดไป 👉
                </button>
            </div>
        </div>
    `;
}

function changeRoomsPage(newPage) {
    const totalPages = Math.ceil(filteredRooms.length / itemsPerPage) || 1;
    if (newPage >= 1 && newPage <= totalPages) {
        currentPage = newPage;
        renderRoomsTable();
    }
}

async function fetchTenantsForRoomSelect() {
    try {
        const res = await fetch('/api/tenants');
        const data = await res.json();
        const datalist = document.getElementById('room-tenant-list');
        if (datalist && data.success) {
            datalist.innerHTML = data.tenants.map(t => `<option value="${escapeHTML(t.name)}"></option>`).join('');
        }
    } catch (e) {
        console.error('Error fetching tenants for rooms:', e);
    }
}

// ฟังก์ชันเตรียมข้อมูลใส่ฟอร์มเพื่อแก้ไข
async function editRoom(id) {
    const room = currentRooms.find(r => Number(r.id) === Number(id));
    if (!room) return;

    await fetchTenantsForRoomSelect(); 

    document.getElementById('roomId').value = room.id;
    document.getElementById('roomDormSelect').value = room.dormitory_id || ''; 
    document.getElementById('roomNumber').value = room.number || '';
    document.getElementById('roomType').value = room.type || 'Type A';
    document.getElementById('roomPrice').value = room.price || '';
    
    // ตั้งค่าเตรียมย้ายออก
    const movingOutTick = document.getElementById('roomMovingOutTick');
    if (movingOutTick) {
        movingOutTick.checked = room.is_moving_out || false;
        toggleMoveOutInput();
        if (room.is_moving_out) {
            document.getElementById('moveOutDay').value = room.move_out_day || '';
            document.getElementById('moveOutMonth').value = room.move_out_month || '';
        }
    }

    // จัดการรูปภาพในโหมดแก้ไข
    const imageDataInput = document.getElementById('roomImageData');
    const previewContainer = document.getElementById('roomImagePreviewContainer');
    const previewImg = document.getElementById('roomImagePreview');

    if (room.image_data) {
    try {
        const parsed = JSON.parse(room.image_data);
        roomImagesArray = Array.isArray(parsed) ? parsed : [room.image_data];
    } catch (e) {
        roomImagesArray = [room.image_data];
    }
        renderRoomImagePreviews();
    } else {
        roomImagesArray = [];
        renderRoomImagePreviews();
    }


    const bookedTick = document.getElementById('roomBookedTick');
    if (room.status === 'Booked') {
        document.getElementById('roomStatus').value = 'Vacant';
        if (bookedTick) bookedTick.checked = true;
    } else {
        document.getElementById('roomStatus').value = room.status || 'Vacant';
        if (bookedTick) bookedTick.checked = false;
    }

    document.getElementById('roomTenant').value = room.status === 'Occupied' ? (room.tenant !== '-' ? room.tenant : '') : '';
    
    toggleTenantInput();
    document.getElementById('room-form-title').innerText = '✏️ แก้ไขข้อมูลห้องพัก';
    document.getElementById('room-submit-btn').innerText = 'บันทึกการแก้ไข';
    document.getElementById('room-cancel-btn').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}


// ฟังก์ชันเปิด-ปิด ช่องระบุวันย้ายออก
function toggleMoveOutInput() {
    const tick = document.getElementById('roomMovingOutTick');
    const box = document.getElementById('moveOutBox');
    
    if (tick && box) {
        if (tick.checked) {
            box.classList.remove('hidden');
            box.classList.add('grid');
        } else {
            box.classList.add('hidden');
            box.classList.remove('grid');
            // ล้างค่าทิ้งเมื่อยกเลิกการติ๊ก
            document.getElementById('moveOutDay').value = '';
            document.getElementById('moveOutMonth').value = '';
        }
    }
}

// ล้างค่าฟอร์มกลับเป็นโหมดเพิ่มข้อมูล
async function resetRoomForm() {
    await fetchTenantsForRoomSelect();

    document.getElementById('roomId').value = '';
    document.getElementById('roomNumber').value = '';
    document.getElementById('roomType').value = 'Type A';
    document.getElementById('roomPrice').value = '';
    document.getElementById('roomStatus').value = 'Vacant';
    document.getElementById('roomTenant').value = '';
    toggleTenantInput();

    document.getElementById('roomStatus').value = 'Vacant';
    const bookedTick = document.getElementById('roomBookedTick');
    if (bookedTick) bookedTick.checked = false;

    document.getElementById('room-form-title').innerText = '➕ เพิ่มห้องพักใหม่เข้าสู่ระบบ';
    document.getElementById('room-submit-btn').innerText = 'บันทึกข้อมูลห้องพัก';
    document.getElementById('room-cancel-btn').classList.add('hidden');
    // เพิ่มการล้างรูปภาพ
    roomImagesArray = [];
    renderRoomImagePreviews();
}

// ฟังก์ชันเดียวรองรับทั้งเพิ่ม (POST) และแก้ไข (PUT)
async function saveRoom(e) {
    e.preventDefault();

    const id = document.getElementById('roomId').value;
    const dormitory_id = document.getElementById('roomDormSelect').value;
    const number = document.getElementById('roomNumber').value;
    const type = document.getElementById('roomType').value;
    const price = document.getElementById('roomPrice').value;
    const statusInput = document.getElementById('roomStatus').value;
    const tenant = document.getElementById('roomTenant')?.value || '';

    const isBooked = document.getElementById('roomBookedTick')?.checked;
    const finalStatus = isBooked ? 'Booked' : statusInput;

    const is_moving_out = document.getElementById('roomMovingOutTick')?.checked || false;
    const move_out_day = document.getElementById('moveOutDay')?.value || '';
    const move_out_month = document.getElementById('moveOutMonth')?.value || '';
    // ดึงค่ารูปภาพ
    const image_data = document.getElementById('roomImageData')?.value || '';

    const payload = { 
        dormitory_id, number, type, price, status: finalStatus, tenant,
        is_moving_out, move_out_day, move_out_month, image_data
    };

    try {
        const url = id ? `/api/rooms/${id}` : '/api/rooms';
        const method = id ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message);

        alert('✅ ' + data.message);
        resetRoomForm();
        await fetchRoomsPage();
    } catch (error) {
        alert('❌ ' + error.message);
    }
}

// ฟังก์ชันลบห้องพัก
async function deleteRoom(id) {
    if (!confirm('คุณแน่ใจหรือไม่ที่จะลบห้องพักนี้?')) {
        return;
    }

    try {
        const res = await fetch(`/api/rooms/${id}`, {
            method: 'DELETE'
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.message || data.error || 'ลบห้องพักไม่สำเร็จ');
        }

        alert('✅ ' + data.message);
        await fetchRoomsPage();

    } catch (error) {
        console.error('Delete Room Error:', error);
        alert('❌ ' + error.message);
    }
}
// =====================================================
// CHATBOT
// =====================================================

// ฟังก์ชันจำลองการรับข้อความจากผู้เช่า (นำไปปรับใช้กับ Event การพิมพ์แชทของคุณ)
function handleTenantMessage(message) {
    // กรณีที่ 1: ผู้เช่าพิมพ์ "ตรวจสอบห้องว่าง"
    if (text === "ตรวจสอบห้องว่าง") {
        const vacantRooms = dashboardRoomsData.filter(r => r.status === 'Vacant'); 
        return renderAvailableRoomsCarousel(vacantRooms);
    }

    // กรณีที่ 2: ผู้เช่าพิมพ์ "สนใจรายละเอียดห้อง ${room.number}" (เช่น "สนใจรายละเอียดห้อง 101")
    const roomMatch = text.match(/^สนใจรายละเอียดห้อง\s*(.+)$/i);
    if (roomMatch) {
        const targetRoomNumber = roomMatch[1].trim();
        
        // ค้นหาห้องพักที่มีเลขห้องตรงกันจากข้อมูลระบบ
        const room = dashboardRoomsData.find(
            r => String(r.number).toLowerCase() === targetRoomNumber.toLowerCase()
        );

        if (room) {
            return renderRoomDetailCard(room);
        } else {
            return `
                <div class="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-rose-700 text-sm font-medium flex items-center gap-2">
                    <span>❌</span>
                    <span>ไม่พบข้อมูลห้องพักหมายเลข <strong>${escapeHTML(targetRoomNumber)}</strong> ในระบบ กรุณาตรวจสอบเลขห้องอีกครั้งค่ะ</span>
                </div>
            `;
        }
    }

    return null;
}
// ฟังก์ชันสร้าง Card แสดงรายละเอียดห้องพักเดี่ยวแบบสวยงาม
function renderRoomDetailCard(room) {
    // 1. จัดการรูปภาพ (ดึงรูปแรก หรือแสดง Placeholder หากไม่มีรูป)
    let coverImage = '';
    let totalImages = 0;

    if (room.image_data) {
        try {
            const parsed = JSON.parse(room.image_data);
            if (Array.isArray(parsed) && parsed.length > 0) {
                coverImage = parsed[0];
                totalImages = parsed.length;
            } else {
                coverImage = room.image_data;
                totalImages = 1;
            }
        } catch (e) {
            coverImage = room.image_data;
            totalImages = 1;
        }
    }

    const imageSection = coverImage 
        ? `<div class="relative w-full h-48 bg-gray-100 overflow-hidden">
            <img src="${coverImage}" class="w-full h-full object-cover">
            ${totalImages > 1 ? `<span class="absolute bottom-2 right-2 bg-black/60 backdrop-blur-md text-white text-[10px] px-2 py-0.5 rounded-full font-bold">📷 +${totalImages - 1} รูป</span>` : ''}
           </div>`
        : `<div class="w-full h-36 bg-indigo-50 flex flex-col items-center justify-center text-indigo-300 gap-1">
            <span class="text-3xl">🏢</span>
            <span class="text-xs font-semibold">ไม่มีรูปภาพประกอบ</span>
           </div>`;

    // 2. สถานะห้องพัก (Color Badge)
    let statusBg = 'bg-amber-500 text-white';
    let statusText = '🟠 ห้องว่างพร้อมอยู่';

    if (room.status === 'Occupied') {
        statusBg = 'bg-emerald-500 text-white';
        statusText = '🟢 มีผู้เช่าแล้ว';
    } else if (room.status === 'Booked') {
        statusBg = 'bg-blue-500 text-white';
        statusText = '📌 ติดจอง';
    }

    // 3. ประกอบโครงสร้าง Card HTML
    return `
        <div class="max-w-xs w-full bg-white rounded-3xl shadow-lg border border-indigo-100 overflow-hidden my-2 font-sans transition-all duration-300 hover:shadow-xl">
            <!-- ภาพส่วนหัว -->
            <div class="relative">
                ${imageSection}
                <span class="absolute top-3 left-3 text-[11px] font-extrabold px-3 py-1 rounded-full shadow-md ${statusBg}">
                    ${statusText}
                </span>
            </div>

            <!-- รายละเอียดห้อง -->
            <div class="p-5">
                <!-- หัวข้อ & หอพัก -->
                <div class="mb-3 border-b border-gray-100 pb-3">
                    <span class="text-xs font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-lg">
                        ${escapeHTML(room.dormitory_name || 'หอพัก')}
                    </span>
                    <h3 class="text-2xl font-black text-gray-800 mt-2">
                        ห้อง ${escapeHTML(room.number)}
                    </h3>
                </div>

                <!-- ข้อมูลคุณสมบัติห้อง -->
                <div class="space-y-2 text-sm text-gray-600 mb-4">
                    <div class="flex justify-between items-center bg-gray-50 p-2.5 rounded-xl">
                        <span class="text-xs text-gray-500">🏢 ประเภทห้อง:</span>
                        <span class="font-bold text-gray-700">${escapeHTML(room.type || 'Standard')}</span>
                    </div>
                    <div class="flex justify-between items-center bg-gray-50 p-2.5 rounded-xl">
                        <span class="text-xs text-gray-500">💰 ค่าเช่ารายเดือน:</span>
                        <span class="text-lg font-black text-indigo-600">${Number(room.price || 0).toLocaleString()} <span class="text-xs font-bold text-gray-500">บาท/เดือน</span></span>
                    </div>
                </div>

                <!-- ปุ่มการทำงาน -->
                <div class="grid grid-cols-2 gap-2 pt-1">
                    <button onclick="showRoomDetailModal(${room.id})" class="w-full py-2.5 bg-indigo-50 text-indigo-700 font-bold text-xs rounded-xl hover:bg-indigo-100 transition-colors flex items-center justify-center gap-1">
                        🔍 ดูรูปเพิ่มเติม
                    </button>
                    ${room.status === 'Vacant' ? `
                        <a href="https://line.me" target="_blank" class="w-full py-2.5 bg-indigo-600 text-white font-bold text-xs rounded-xl hover:bg-indigo-700 transition-colors flex items-center justify-center gap-1 shadow-md shadow-indigo-200">
                            ✨ สนใจจองห้อง
                        </a>
                    ` : `
                        <button disabled class="w-full py-2.5 bg-gray-100 text-gray-400 font-bold text-xs rounded-xl cursor-not-allowed">
                            ไม่พร้อมจอง
                        </button>
                    `}
                </div>
            </div>
        </div>
    `;
}
// ฟังก์ชันสร้างการ์ดห้องว่างแบบเลื่อนไปด้านข้าง (Carousel)
function renderAvailableRoomsCarousel(rooms) {
    // กรณีไม่มีห้องว่าง
    if (!rooms || rooms.length === 0) {
        return `<div class="p-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-500 text-sm">
                    ขออภัยค่ะ ขณะนี้ไม่มีห้องว่างเลยค่ะ
                </div>`;
    }

    // สร้าง HTML การ์ดแต่ละใบ
    const cardsHtml = rooms.map(r => {
        // จัดการรูปภาพ (ตรวจสอบว่ามีข้อมูลและเป็น JSON Array หรือไม่)[cite: 42]
        let coverImage = '';
        if (r.image_data) {
            try {
                const parsed = JSON.parse(r.image_data);
                coverImage = Array.isArray(parsed) ? parsed[0] : r.image_data;
            } catch (e) {
                coverImage = r.image_data;
            }
        }

        const imgElement = coverImage 
            ? `<img src="${coverImage}" class="w-full h-32 object-cover">` 
            : `<div class="w-full h-32 bg-gray-100 flex items-center justify-center text-gray-400 text-xs">ไม่มีรูปภาพ</div>`;

        // สร้างการ์ดโดยระบุ onclick="showRoomDetailModal(roomId)" เพื่อเปิดดูรายละเอียด
        return `
            <div onclick="showRoomDetailModal(${r.id})" class="flex-shrink-0 w-64 bg-white rounded-2xl shadow-sm border border-gray-100 cursor-pointer snap-center hover:shadow-md hover:border-indigo-300 transition-all duration-300 overflow-hidden group">
                <div class="relative overflow-hidden">
                    ${imgElement}
                    <div class="absolute top-2 right-2 px-2 py-1 bg-white/90 backdrop-blur-sm text-orange-600 text-[10px] font-bold rounded-lg border border-orange-100">
                        ห้องว่าง
                    </div>
                </div>
                <div class="p-4">
                    <div class="flex justify-between items-start mb-1">
                        <div>
                            <h4 class="font-bold text-gray-800 text-lg group-hover:text-indigo-600 transition-colors">ห้อง ${escapeHTML(r.number)}</h4>
                            <p class="text-[11px] text-gray-500 font-medium">${escapeHTML(r.dormitory_name || 'ไม่ระบุหอพัก')}</p>
                        </div>
                    </div>
                    <div class="flex justify-between items-center mt-3 pt-3 border-t border-gray-50 text-sm">
                        <span class="text-gray-500 bg-gray-50 px-2 py-0.5 rounded text-xs">${escapeHTML(r.type || 'Standard')}</span>
                        <span class="font-extrabold text-indigo-600">${Number(r.price || 0).toLocaleString()} ฿</span> <!--[cite: 42] -->
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // หุ้มการ์ดทั้งหมดด้วย Container ที่สามารถ Scroll แนวนอนได้ (overflow-x-auto)
    return `
        <div class="w-full max-w-full my-2">
            <p class="mb-2 text-sm text-gray-600 font-medium">พบห้องว่าง <span class="font-bold text-indigo-600">${rooms.length}</span> ห้อง แตะเพื่อดูรายละเอียด 👇</p>
            <!-- ตั้งค่า flex, overflow-x-auto, และ snap-x สำหรับการเลื่อนแบบชิ้นต่อชิ้น -->
            <div class="flex overflow-x-auto gap-3 pb-4 snap-x snap-mandatory scroll-smooth hide-scrollbar" style="scrollbar-width: none; -ms-overflow-style: none;">
                ${cardsHtml}
            </div>
        </div>
    `;
}

// =====================================================
// OCR SYSTEM
// =====================================================
async function handleOcrUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const nameInput = document.getElementById('ocr-name');
    const idInput = document.getElementById('ocr-id');
    const addressInput = document.getElementById('ocr-address');
    const phoneInput = document.getElementById('ocr-phone');
    const parentPhoneInput = document.getElementById('ocr-parent-phone');

    // แสดงสถานะกำลังโหลด
    if(nameInput) nameInput.value = 'กำลังประมวลผล...';
    if(idInput) idInput.value = 'กำลังประมวลผล...';
    if(addressInput) addressInput.value = 'กำลังประมวลผล...';

    const reader = new FileReader();
    
    reader.onload = async function(e) {
        const base64Image = e.target.result;

        try {
            const res = await fetch('/api/ocr', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_data: base64Image })
            });

            const result = await res.json();

            if (!res.ok || !result.success) {
                throw new Error(result.message || 'ไม่สามารถดึงข้อมูล OCR ได้');
            }

            // นำผลลัพธ์ใส่ฟอร์มและอนุญาตให้ผู้ใช้แก้ได้ทันที
            if(nameInput) nameInput.value = result.data.name !== 'ไม่พบชื่อ-นามสกุล' ? result.data.name : '';
            if(idInput) idInput.value = result.data.id_card !== 'ไม่พบเลขบัตรประชาชน' ? result.data.id_card : '';
            if(addressInput) addressInput.value = result.data.address || '';
            
            // เบอร์โทรศัพท์ไม่มีในบัตร ให้เว้นว่างไว้ให้ผู้ใช้กรอก
            if(phoneInput) phoneInput.value = '';
            if(parentPhoneInput) parentPhoneInput.value = '';

            alert('✅ ' + result.message);

        } catch (error) {
            console.error('OCR Upload Error:', error);
            alert('❌ ' + error.message);
            if(nameInput) nameInput.value = '';
            if(idInput) idInput.value = '';
            if(addressInput) addressInput.value = '';
        }
    };

    reader.onerror = function() {
        alert('❌ ไม่สามารถอ่านไฟล์รูปภาพได้');
    };

    reader.readAsDataURL(file);
}
// =====================================================
// GENERATE BILLS
// =====================================================
async function fetchBillingOptions() {
    try {
        const resDorms = await fetch('/api/dormitories');
        const dormsData = await resDorms.json();
        const dormSelect = document.getElementById('billDormName');
        if (dormSelect && dormsData.success) {
            dormSelect.innerHTML = '<option value="">-- เลือกกลุ่มหอพัก --</option>' + 
                dormsData.dormitories.map(d => `<option value="${escapeHTML(d.name)}">${escapeHTML(d.name)}</option>`).join('');
        }

        const resLine = await fetch('/api/line-friends');
        const lineData = await resLine.json();
        const lineSelect = document.getElementById('billLineUser');
        if (lineSelect && lineData.success) {
            lineSelect.innerHTML = '<option value="">-- ไม่ส่ง LINE / พิมพ์ชื่อเพื่อค้นหา --</option>' + 
                lineData.friends.map(f => `<option value="${f.user_id}">${escapeHTML(f.display_name)}</option>`).join('');
        }

        // เพิ่มการโหลดตัวเลือกบัญชีรับเงินเข้า Dropdown
        await loadPaymentOptionsForBilling();
    } catch (e) {
        console.error('Error fetching billing options:', e);
    }
}

function togglePayMethod() {
    const method = document.getElementById('payMethod').value;
    const bankInfo = document.getElementById('bankInfo');
    const qrSection = document.getElementById('qrUploadSection');
    
    if (method === 'qr') {
        bankInfo.style.display = 'none';
        qrSection.style.display = 'block';
    } else {
        bankInfo.style.display = 'grid'; // คืนค่า grid กลับมา
        qrSection.style.display = 'none';
    }
}

// 2. แปลงรูปภาพที่อัปโหลดเป็น Base64 ทันที
document.addEventListener('change', function(e) {
    if (e.target && e.target.id === 'payQrImage') {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                document.getElementById('payQrBase64').value = ev.target.result;
            };
            reader.readAsDataURL(file);
        } else {
            document.getElementById('payQrBase64').value = '';
        }
    }
});

let currentBillingRooms = [];

async function fetchRoomsForBilling() {
    const selectedDorm = document.getElementById('billDormName')?.value;
    const roomSelect = document.getElementById('billRoom');
    if (!roomSelect) return;

    roomSelect.innerHTML = '<option value="">-- กำลังโหลดห้องพัก --</option>';
    
    // รีเซ็ต LINE ID และข้อมูลชำระเงินทุกครั้งที่เปลี่ยนกลุ่มหอพัก
    const lineSelect = document.getElementById('billLineUser');
    if (lineSelect) lineSelect.value = '';
    resetBillingPaymentForm();

    if (!selectedDorm) {
        roomSelect.innerHTML = '<option value="">-- เลือกห้องพัก --</option>';
        return;
    }

    try {
        const res = await fetch('/api/rooms');
        const rooms = await res.json();
        
        // กรองเฉพาะห้องที่มีผู้เช่าและอยู่ในหอพักที่เลือก
        currentBillingRooms = rooms.filter(r => r.dormitory_name === selectedDorm && r.status === 'Occupied');

        if (currentBillingRooms.length === 0) {
            roomSelect.innerHTML = '<option value="">-- ไม่พบห้องที่มีผู้เช่าในหอพักนี้ --</option>';
            return;
        }

        roomSelect.innerHTML = '<option value="">-- เลือกห้องพัก --</option>' + 
            currentBillingRooms.map(r => `<option value="${escapeHTML(r.number)}">ห้อง ${escapeHTML(r.number)} (${escapeHTML(r.tenant || '-')})</option>`).join('');
            
        // เปลี่ยนใช้ roomSelect.onchange แทน addEventListener เพื่อป้องกัน Event ซ้ำซ้อน
        roomSelect.onchange = function() {
            const selectedRoomNumber = this.value;
            const roomData = currentBillingRooms.find(r => r.number === selectedRoomNumber);
            
            if (lineSelect && roomData && roomData.line_id) {
                lineSelect.value = roomData.line_id; // เลือก LINE ID ให้อัตโนมัติ
            } else if (lineSelect) {
                lineSelect.value = ""; // เว้นว่างหากผู้เช่าคนนั้นไม่มี LINE ID
            }

            // ล้างค่าฟอร์มการชำระเงินเดิมออก
            resetBillingPaymentForm();

            // หากห้องนี้มีเลขบัญชีผูกไว้อยู่แล้ว ให้เลือกให้อัตโนมัติ
            if (roomData && roomData.account_number) {
                autoSelectPaymentAccountByNumber(roomData.account_number);
            }
        };

    } catch (e) {
        console.error('Error fetching rooms for billing:', e);
        roomSelect.innerHTML = '<option value="">-- เกิดข้อผิดพลาดในการโหลดห้อง --</option>';
    }
}

// 1. เพิ่มฟังก์ชันสลับความสว่าง/ปิดการใช้งาน 
function toggleOptFee() {
    const isChecked = document.getElementById('optFeeCheck').checked;
    const container = document.getElementById('optFeeContainer');
    const btnAdd = document.getElementById('btnAddOptFee');
    
    if (isChecked) {
        container.classList.remove('opacity-50', 'pointer-events-none');
        if(btnAdd) btnAdd.classList.remove('hidden');
    } else {
        container.classList.add('opacity-50', 'pointer-events-none');
        if(btnAdd) btnAdd.classList.add('hidden');
        // ล้างค่าที่กรอกไว้เมื่อติ๊กออก
        document.querySelectorAll('.optFeeName').forEach(el => el.value = '');
        document.querySelectorAll('.optFeeAmount').forEach(el => el.value = '');
    }
}

function addOptFeeRow() {
    const list = document.getElementById('optFeeList');
    const row = document.createElement('div');
    row.className = 'flex gap-2 opt-fee-row mt-2';
    row.innerHTML = `
        <div class="flex-1">
            <input type="text" class="optFeeName block w-full rounded-md border-gray-300 shadow-sm p-2 border bg-white" placeholder="เช่น ค่าที่จอดรถ">
        </div>
        <div class="w-32">
            <input type="number" class="optFeeAmount block w-full rounded-md border-gray-300 shadow-sm p-2 border bg-white" placeholder="0">
        </div>
        <div class="flex items-end">
            <button type="button" onclick="removeOptFeeRow(this)" class="bg-red-500 text-white px-3 py-2 rounded-md hover:bg-red-600 w-full">
                ลบ
            </button>
        </div>
    `;
    list.appendChild(row);
}

function removeOptFeeRow(btn) {
    const list = document.getElementById('optFeeList');
    const row = btn.closest('.opt-fee-row');
    
    // ถ้าเหลือแถวเดียว ไม่ให้ลบโครงสร้าง แต่ให้เคลียร์ค่าแทน
    if (list.querySelectorAll('.opt-fee-row').length > 1) {
        row.remove();
    } else {
        row.querySelector('.optFeeName').value = '';
        row.querySelector('.optFeeAmount').value = '';
    }
}
async function generateBills() {
    const dormName = document.getElementById('billDormName')?.value;
    const roomNumber = document.getElementById('billRoom')?.value;
    const billMonth = document.getElementById('billMonth')?.value;
    const lineUserId = document.getElementById('billLineUser')?.value;

    const elecPrev = document.getElementById('elecPrev')?.value;
    const elecCurr = document.getElementById('elecCurr')?.value;
    const elecRate = document.getElementById('elecRate')?.value;
    const waterPrev = document.getElementById('waterPrev')?.value;
    const waterCurr = document.getElementById('waterCurr')?.value;
    const waterRate = document.getElementById('waterRate')?.value;
    const payMethod = document.getElementById('payMethod')?.value;
    const payBank = document.getElementById('payBank')?.value;
    const payAccountNo = document.getElementById('payAccountNo')?.value;
    const payName = document.getElementById('payName')?.value;
    const dueDate = document.getElementById('billDueDate')?.value; 
    const finePerDay = document.getElementById('finePerDay')?.value;
    const payPhone = document.getElementById('payPhone')?.value;
    const optFeeName = document.getElementById('optFeeName')?.value;
    const optFeeCheck = document.getElementById('optFeeCheck')?.checked;
    let optFees = [];
    if (optFeeCheck) {
        document.querySelectorAll('.opt-fee-row').forEach(row => {
            const name = row.querySelector('.optFeeName').value.trim();
            const amount = Number(row.querySelector('.optFeeAmount').value) || 0;
            if (name || amount > 0) {
                optFees.push({ name: name || 'ค่าใช้จ่ายเพิ่มเติมอื่นๆ', amount });
            }
        });
    }

    // ดึงค่า Base64 ของ QR Code
    const payQrBase64 = document.getElementById('payQrBase64')?.value;

    if (!billMonth) {
        alert('กรุณาเลือกประจำเดือนที่ออกบิล');
        return;
    }

    if (!dueDate) {
        alert('กรุณากำหนดวัน/เดือนที่ครบกำหนดชำระ');
        return;
    }
    
    if (payMethod === 'account' && !payAccountNo) {
        alert('กรุณากรอกเลขบัญชี');
        return;
    }
    if (payMethod === 'qr' && !payQrBase64) {
        alert('กรุณาอัปโหลดรูป QR Code');
        return;
    }

    if (!payName || !payPhone) {
        alert('กรุณากรอกชื่อผู้รับเงินและเบอร์โทรศัพท์');
        return;
    }
 
    
    if (!dormName) {
        alert('กรุณาเลือกกลุ่มหอพัก');
        return;
    }
    if (!roomNumber) {
        alert('กรุณาเลือกห้องพักที่ต้องการออกบิล');
        return;
    }
    if (!elecPrev || !elecCurr || !waterPrev || !waterCurr) {
        alert('กรุณากรอกเลขมิเตอร์น้ำ-ไฟ ให้ครบถ้วน');
        return;
    }

    // คำนวณวันเกินกำหนด
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);
    let isOverdue = false;
    let overdueDays = 0;
    let fineAmount = 0;

    if (today > due) {
        isOverdue = true;
        overdueDays = Math.ceil((today - due) / (1000 * 60 * 60 * 24));
        fineAmount = overdueDays * (Number(finePerDay) || 0); // แปลงเป็นตัวเลขและดักค่าว่าง
    }

    try {
        const res = await fetch('/api/generate-bills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                dormName, roomNumber, lineUserId, billMonth, 
                elecPrev, elecCurr, elecRate, 
                waterPrev, waterCurr, waterRate,
                payMethod, payBank, payAccountNo, payName, payPhone, payQrBase64,
                optFeeCheck, optFees,
                dueDate,
                finePerDay,
                isOverdue,
                overdueDays,
                fineAmount
            })
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.message || 'ไม่สามารถออกบิลได้');
        }

        // เคลียร์ค่าผู้รับเงินเมื่อสร้างบิลสำเร็จ
        resetBillingPaymentForm();

        const result = document.getElementById('billing-result');
        if (result) {
            result.innerHTML = `
                <div class="p-4 bg-green-50 border border-green-200 text-green-700 rounded-lg mb-4">
                    ✅ ${escapeHTML(data.message)}
                </div>
            `;
        }
    } catch (error) {
        console.error('Generate Bills Error:', error);
        alert('❌ ' + error.message);
    }
}

// =====================================================
// SEARCH EXPORTED BILLS
// =====================================================

function searchExportedBills() {
    const keyword = document.getElementById('searchBillInput').value.toLowerCase();
    const billCards = document.querySelectorAll('#bills-grid > div.bg-white'); 
    let hasVisible = false;

    billCards.forEach(card => {
        // ดึงชื่อไฟล์จากแท็ก p ภายในการ์ด
        const fileName = card.querySelector('p').innerText.toLowerCase();
        
        if (fileName.includes(keyword)) {
            card.style.display = 'flex';
            hasVisible = true;
        } else {
            card.style.display = 'none';
        }
    });

    // แสดงข้อความแจ้งเตือนเมื่อค้นหาไม่พบข้อมูล
    let noResultMsg = document.getElementById('no-bill-result');
    
    if (!hasVisible && billCards.length > 0) {
        if (!noResultMsg) {
            const grid = document.getElementById('bills-grid');
            const msg = document.createElement('div');
            msg.id = 'no-bill-result';
            msg.className = 'col-span-full text-center py-12 text-gray-500 font-bold';
            msg.innerHTML = '🔍 ไม่พบชื่อไฟล์บิลที่ค้นหา';
            grid.appendChild(msg);
        } else {
            noResultMsg.style.display = 'block';
        }
    } else if (noResultMsg) {
        noResultMsg.style.display = 'none';
    }
}

// =====================================================
// VERIFY SLIP (SlipOK Real Verification)
// =====================================================
async function verifySlip() {
    const fileInput = document.getElementById('slipFile');
    const resultDiv = document.getElementById('slip-result');
    const expectedAccount = document.getElementById('expectedAccount')?.value.replace(/[^0-9]/g, '');
    const file = fileInput?.files[0];

    if (!file) {
        alert('กรุณาเลือกไฟล์สลิปก่อนทำการตรวจสอบ');
        return;
    }

    resultDiv.innerHTML = `<div class="p-4 bg-blue-50 text-blue-700 rounded-lg animate-pulse">⏳ กำลังตรวจสอบสลิป...</div>`;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const res = await fetch('/api/verify-slip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_data: e.target.result })
            });
            const result = await res.json();

            // สลิปซ้ำ สลิปปลอม หรือ API ส่ง error
            if (!res.ok || !result.success) {
                resultDiv.innerHTML = `<div class="p-4 bg-red-50 text-red-700 rounded-lg font-bold">ไม่สารถชำระเงินได้ โปรดตรวจสอบสลิปและส่งอีกครั้งหรือติดต่อแอดมิน</div>`;
                return;
            }

            const data = result.data;
            const receiverAccount = (data.receiver?.account || data.receiver?.proxy?.value || '').replace(/[^0-9]/g, '');

            // สลิปถูกต้อง แต่เลขบัญชีผู้รับไม่ตรงกับที่ระบุ
            if (expectedAccount && !receiverAccount.includes(expectedAccount) && receiverAccount !== expectedAccount) {
                resultDiv.innerHTML = `<div class="p-4 bg-red-50 text-red-700 rounded-lg font-bold">ไม่สารถชำระเงินได้ โปรดตรวจสอบสลิปและส่งอีกครั้งหรือติดต่อแอดมิน</div>`;
                return;
            }

            // ชำระเงินเสร็จสิ้น
            resultDiv.innerHTML = `<div class="p-4 bg-green-50 text-green-700 rounded-lg font-bold">ชำระเงินเสร็จสิ้น</div>`;

        } catch (error) {
            resultDiv.innerHTML = `<div class="p-4 bg-red-50 text-red-700 rounded-lg font-bold">ไม่สารถชำระเงินได้ โปรดตรวจสอบสลิปและส่งอีกครั้งหรือติดต่อแอดมิน</div>`;
        }
    };
    reader.readAsDataURL(file);
}

// =====================================================
// CARD SYSTEM
// =====================================================


// -----------------------------------------------------
// GET + RENDER CARDS
// -----------------------------------------------------

async function fetchAndRenderCards() {

    const container =
        document.getElementById(
            'card-container'
        );


    if (!container) {

        console.warn(
            'ไม่พบ #card-container'
        );

        return;

    }


    container.innerHTML = `

        <div
            class="
                col-span-full
                text-center
                py-10
                text-gray-400
            "
        >
            กำลังโหลดการ์ด...
        </div>

    `;


    try {

        const res =
            await fetch('/api/cards');


        const data =
            await res.json();


        if (!res.ok) {

            throw new Error(
                data.message ||
                data.error ||
                'ไม่สามารถโหลดการ์ดได้'
            );

        }


        currentCards =
            Array.isArray(data)
                ? data
                : [];


        container.innerHTML = '';


        // ไม่มีการ์ด
        if (
            currentCards.length === 0
        ) {

            container.innerHTML = `

                <div
                    class="
                        col-span-full
                        text-center
                        py-10
                        text-gray-400
                    "
                >

                    <div
                        class="
                            text-5xl
                            mb-3
                        "
                    >
                        📋
                    </div>

                    <p>
                        ยังไม่มีข้อมูลการ์ด
                    </p>

                    <p class="text-sm mt-1">
                        กด "เพิ่มการ์ดใหม่"
                        เพื่อเริ่มต้น
                    </p>

                </div>

            `;

            return;

        }


        // Render
        currentCards.forEach(card => {

            const imageHTML =
                card.image_data
                    ? `

                        <img
                            src="${card.image_data}"
                            class="
                                w-full
                                h-full
                                object-cover
                            "
                            alt="${escapeHTML(
                                card.title
                            )}"
                        >

                    `
                    : `

                        <div
                            class="
                                flex
                                items-center
                                justify-center
                                h-full
                                text-gray-400
                                text-sm
                            "
                        >
                            ไม่มีรูปภาพ
                        </div>

                    `;


            const cardHTML = `

                <div
                    class="
                        bg-white
                        rounded-xl
                        shadow-sm
                        border
                        border-gray-100
                        overflow-hidden
                        hover:shadow-md
                        transition
                        group
                    "
                >

                    <!-- IMAGE -->

                    <div
                        class="
                            h-48
                            bg-gray-100
                            relative
                        "
                    >

                        ${imageHTML}


                        <!-- ACTIONS -->

                        <div
                            class="
                                absolute
                                top-3
                                right-3
                                flex
                                space-x-2
                                opacity-0
                                group-hover:opacity-100
                                transition-opacity
                            "
                        >

                            <button
                                onclick="openCardModal(${card.id})"
                                class="
                                    p-2
                                    bg-white
                                    text-blue-600
                                    rounded-full
                                    shadow
                                    hover:bg-blue-50
                                "
                                title="แก้ไข"
                            >
                                ✏️
                            </button>


                            <button
                                onclick="deleteCard(${card.id})"
                                class="
                                    p-2
                                    bg-white
                                    text-red-600
                                    rounded-full
                                    shadow
                                    hover:bg-red-50
                                "
                                title="ลบ"
                            >
                                🗑️
                            </button>

                        </div>

                    </div>


                    <!-- CONTENT -->

                    <div class="p-5">

                        <h4
                            class="
                                font-bold
                                text-gray-800
                                text-lg
                                mb-2
                            "
                        >
                            ${escapeHTML(
                                card.title
                            )}
                        </h4>


                        <p
                            class="
                                text-sm
                                text-gray-500
                                line-clamp-3
                            "
                        >
                            ${escapeHTML(
                                card.description || ''
                            )}
                        </p>

                    </div>

                </div>

            `;


            container.insertAdjacentHTML(
                'beforeend',
                cardHTML
            );

        });


    } catch (error) {

        console.error(
            'Fetch Cards Error:',
            error
        );


        container.innerHTML = `

            <div
                class="
                    col-span-full
                    p-6
                    bg-red-50
                    border
                    border-red-200
                    rounded-lg
                    text-red-700
                "
            >

                ❌ ไม่สามารถโหลดการ์ดได้

                <div class="text-sm mt-2">
                    ${escapeHTML(
                        error.message
                    )}
                </div>

            </div>

        `;

    }

}
// =====================================================
// TENANT MANAGEMENT SYSTEM ( app_17.js )
// =====================================================
let currentTenants = [];

// ดึงข้อมูลผู้เช่าทั้งหมดจากฐานข้อมูลมาแสดงในการ์ด
async function fetchTenants() {
    const grid = document.getElementById('tenant-grid');
    if (!grid) return;

    grid.innerHTML = `<div class="col-span-full text-center py-10 text-indigo-400 font-medium animate-pulse">⏳ กำลังโหลดข้อมูลผู้เช่า...</div>`;

    try {
        // ยิง Request ไปยัง API ของ Server เพื่ออ่านข้อมูลจาก DB
        const res = await fetch('/api/tenants');
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.message || 'ไม่สามารถโหลดข้อมูลผู้เช่าได้');
        }

        currentTenants = data.tenants || [];

        // กรณีไม่มีข้อมูลในฐานข้อมูล
        if (currentTenants.length === 0) {
            grid.innerHTML = `
                <div class="col-span-full flex flex-col items-center justify-center py-16 bg-white rounded-3xl border-2 border-dashed border-gray-200">
                    <div class="text-6xl mb-4 opacity-50">👻</div>
                    <p class="text-gray-500 text-lg font-bold">ยังไม่มีข้อมูลผู้เช่าในระบบ</p>
                    <p class="text-gray-400 text-sm mt-1">เริ่มต้นจัดการหอพักด้วยการเพิ่มรายชื่อผู้เช่า</p>
                    <button onclick="openTenantModal()" class="mt-5 px-5 py-2.5 bg-indigo-50 text-indigo-600 rounded-xl font-bold hover:bg-indigo-100 transition-colors">
                        + เพิ่มผู้เช่าคนแรก
                    </button>
                </div>
            `;
            return;
        }

        // นำข้อมูล array (currentTenants) จาก DB มา Render เป็น HTML การ์ด
        grid.innerHTML = currentTenants.map(t => {
            const shortName = t.name ? t.name.trim().substring(0, 2) : '👤';
            return `
                <div class="group bg-white rounded-2xl p-6 shadow-sm hover:shadow-xl border border-gray-100 hover:border-indigo-100 transition-all duration-300 flex flex-col justify-between transform hover:-translate-y-1">
                    <div>
                        <div class="flex items-start justify-between mb-4">
                            <div class="flex items-center space-x-4">
                                <div class="w-14 h-14 bg-gradient-to-br from-indigo-100 to-violet-100 text-indigo-700 rounded-2xl flex items-center justify-center font-extrabold text-xl shadow-inner border border-indigo-50">
                                    ${escapeHTML(shortName)}
                                </div>
                                <div>
                                    <h3 class="font-bold text-gray-900 text-lg group-hover:text-indigo-700 transition-colors">${escapeHTML(t.name)}</h3>
                                    <div class="flex items-center gap-1.5 mt-0.5">
                                        <span class="w-2 h-2 rounded-full bg-emerald-500 shadow-sm"></span>
                                        <span class="text-xs text-gray-500 font-medium">ผู้เช่าปัจจุบัน</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="space-y-3 text-sm text-gray-600 mt-5 mb-6 bg-gray-50/50 rounded-xl p-4 border border-gray-100/50">
                            <p class="flex items-center gap-3"><span class="text-lg opacity-80">🪪</span> <span class="font-mono font-semibold text-gray-700">${escapeHTML(t.id_card || '-')}</span></p>
                            <p class="flex items-center gap-3"><span class="text-lg opacity-80">📱</span> <span class="font-semibold">${escapeHTML(t.phone || '-')}</span></p>
                            <p class="flex items-center gap-3"><span class="text-lg opacity-80">👨‍👩‍👧</span> <span class="text-gray-400 text-xs w-16">ผู้ปกครอง</span> <span class="font-medium">${escapeHTML(t.parent_phone || '-')}</span></p>
                            <p class="flex items-center gap-3"><span class="text-lg opacity-80">💬</span> <span class="text-gray-400 text-xs w-16">LINE ID</span> <span class="text-emerald-600 font-semibold">${escapeHTML(t.display_name || t.line_id || '-')}</span></p>
                            <p class="flex items-start gap-3 pt-2 border-t border-gray-100 mt-2"><span class="text-lg mt-0.5 opacity-80">🏠</span> <span class="text-xs text-gray-500 leading-relaxed line-clamp-2 mt-1">${escapeHTML(t.address || '-')}</span></p>
                        </div>
                    </div>

                    <!-- Action Buttons -->
                    <div class="flex items-center justify-end space-x-2 pt-1">
                        <button onclick="editTenant(${t.id})" class="px-4 py-2 text-xs font-bold text-indigo-600 bg-indigo-50 rounded-xl hover:bg-indigo-600 hover:text-white transition-colors flex items-center gap-1.5">
                            แก้ไข
                        </button>
                        <button onclick="deleteTenant(${t.id})" class="px-4 py-2 text-xs font-bold text-rose-600 bg-rose-50 rounded-xl hover:bg-rose-600 hover:text-white transition-colors flex items-center gap-1.5">
                            ลบ
                        </button>
                    </div>
                </div>
            `;
        }).join('');

    } catch (error) {
        console.error(error);
        grid.innerHTML = `<div class="col-span-full text-center py-10 text-rose-500 font-bold bg-rose-50 rounded-2xl">❌ ${error.message}</div>`;
    }
}

async function fetchLineFriendsForTenant() {
    try {
        const res = await fetch('/api/line-friends');
        const data = await res.json();
        const datalist = document.getElementById('line-friends-list'); 
        if (datalist && data.success) {
            datalist.innerHTML = data.friends.map(f => `<option value="${f.user_id}">${escapeHTML(f.display_name)}</option>`).join('');
        }
    } catch (e) {
        console.error('Error fetching LINE friends:', e);
    }
}

// เปิด-ปิด Modal
async function openTenantModal(id = null) {
    const modal = document.getElementById('tenantModal');
    const form = document.getElementById('tenant-form');
    const modalTitle = document.getElementById('modal-tenant-title');

    form.reset();
    document.getElementById('tenant-id').value = '';

    // โหลดรายชื่อ LINE เสมอเมื่อเปิด Modal
    await fetchLineFriendsForTenant();

    if (id) {
        const tenant = currentTenants.find(t => Number(t.id) === Number(id));
        if (tenant) {
            modalTitle.innerText = '✏️ แก้ไขข้อมูลผู้เช่า';
            document.getElementById('tenant-id').value = tenant.id;
            document.getElementById('ocr-name').value = tenant.name || '';
            document.getElementById('ocr-id').value = tenant.id_card || '';
            document.getElementById('ocr-phone').value = tenant.phone || '';
            document.getElementById('ocr-parent-phone').value = tenant.parent_phone || '';
            document.getElementById('ocr-line-id').value = tenant.line_id || '';
            document.getElementById('ocr-address').value = tenant.address || '';
        }
    } else {
        modalTitle.innerText = '➕ เพิ่มข้อมูลผู้เช่าใหม่';
    }

    modal.classList.remove('hidden');
}

function closeTenantModal() {
    const modal = document.getElementById('tenantModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}
// บันทึก/แก้ไขข้อมูลผู้เช่า (POST / PUT)
// บันทึก/แก้ไขข้อมูลผู้เช่า (POST / PUT)
async function saveTenant(e) {
    e.preventDefault();

    const id = document.getElementById('tenant-id')?.value;
    const name = document.getElementById('ocr-name')?.value.trim();
    const id_card = document.getElementById('ocr-id')?.value.trim();
    const phone = document.getElementById('ocr-phone')?.value.trim();
    const parent_phone = document.getElementById('ocr-parent-phone')?.value.trim();
    const line_id = document.getElementById('ocr-line-id')?.value.trim();
    const address = document.getElementById('ocr-address')?.value.trim();

    if (!name) {
        return alert('กรุณากรอกชื่อ-นามสกุลผู้เช่า');
    }

    const payload = { name, id_card, phone, parent_phone, line_id, address };

    try {
        const url = id ? `/api/tenants/${id}` : '/api/tenants';
        const method = id ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'บันทึกข้อมูลผู้เช่าไม่สำเร็จ');

        alert('✅ ' + data.message);
        closeTenantModal();
        await fetchTenants();
    } catch (error) {
        console.error('Save Tenant Error:', error);
        alert('❌ ' + error.message);
    }
}

// ลบผู้เช่า
async function deleteTenant(id) {
    if (!confirm('คุณแน่ใจหรือไม่ที่จะลบรายชื่อผู้เช่านี้?')) return;

    try {
        const res = await fetch(`/api/tenants/${id}`, { method: 'DELETE' });
        const result = await res.json();

        if (!res.ok || !result.success) throw new Error(result.message);

        alert('✅ ' + result.message);
        fetchTenants();

    } catch (error) {
        alert('❌ ' + error.message);
    }
}

// Export ตัวแปรไปที่ Window ให้ HTML เรียกใช้งานได้
window.openTenantModal = openTenantModal;
window.closeTenantModal = closeTenantModal;
window.saveTenant = saveTenant;
window.editTenant = openTenantModal;
window.deleteTenant = deleteTenant;



// -----------------------------------------------------
// OPEN CARD MODAL
// -----------------------------------------------------

function openCardModal(id = null) {

    const modal =
        document.getElementById(
            'card-modal'
        );


    const titleEl =
        document.getElementById(
            'modal-title'
        );


    const idEl =
        document.getElementById(
            'card-id'
        );


    const titleInput =
        document.getElementById(
            'card-title'
        );


    const descInput =
        document.getElementById(
            'card-desc'
        );


    const imageInput =
        document.getElementById(
            'card-image-file'
        );


    const imageData =
        document.getElementById(
            'card-image-data'
        );


    const previewContainer =
        document.getElementById(
            'card-image-preview-container'
        );


    const previewImg =
        document.getElementById(
            'card-image-preview'
        );


    // Reset

    idEl.value = '';

    titleInput.value = '';

    descInput.value = '';

    imageInput.value = '';

    imageData.value = '';

    previewContainer.classList.add(
        'hidden'
    );

    previewImg.src = '';


    // Edit

    if (id !== null) {

        titleEl.innerText =
            'แก้ไขการ์ด';


        const card =
            currentCards.find(
                c => Number(c.id) === Number(id)
            );


        if (card) {

            idEl.value =
                card.id;


            titleInput.value =
                card.title || '';


            descInput.value =
                card.description || '';


            if (card.image_data) {

                imageData.value =
                    card.image_data;


                previewImg.src =
                    card.image_data;


                previewContainer.classList.remove(
                    'hidden'
                );

            }

        }

    }

    // Add

    else {

        titleEl.innerText =
            'เพิ่มการ์ดใหม่';

    }


    modal.classList.remove(
        'hidden'
    );

}


// -----------------------------------------------------
// CLOSE MODAL
// -----------------------------------------------------

function closeCardModal() {

    const modal =
        document.getElementById(
            'card-modal'
        );


    modal.classList.add(
        'hidden'
    );

}


// -----------------------------------------------------
// IMAGE PREVIEW
// -----------------------------------------------------

function previewCardImage(event) {

    const file =
        event.target.files[0];


    if (!file) {
        return;
    }


    // จำกัด 8MB
    if (file.size > 8 * 1024 * 1024) {

        alert(
            '❌ รูปภาพต้องมีขนาดไม่เกิน 8MB'
        );


        event.target.value = '';

        return;

    }


    if (!file.type.startsWith('image/')) {

        alert(
            '❌ กรุณาเลือกไฟล์รูปภาพเท่านั้น'
        );


        event.target.value = '';

        return;

    }


    const reader =
        new FileReader();


    reader.onload = function(e) {

        const base64Image =
            e.target.result;


        document.getElementById(
            'card-image-data'
        ).value =
            base64Image;


        document.getElementById(
            'card-image-preview'
        ).src =
            base64Image;


        document
            .getElementById(
                'card-image-preview-container'
            )
            .classList.remove(
                'hidden'
            );

    };


    reader.onerror = function() {

        alert(
            '❌ ไม่สามารถอ่านรูปภาพได้'
        );

    };


    reader.readAsDataURL(file);

}


// -----------------------------------------------------
// SAVE CARD
// -----------------------------------------------------

async function saveCard() {

    const id =
        document.getElementById(
            'card-id'
        ).value;


    const title =
        document.getElementById(
            'card-title'
        ).value.trim();


    const desc =
        document.getElementById(
            'card-desc'
        ).value.trim();


    const image =
        document.getElementById(
            'card-image-data'
        ).value;


    // Validate

    if (!title) {

        alert(
            'กรุณากรอกหัวข้อการ์ด'
        );

        return;

    }


    const payload = {

        title,

        desc,

        image

    };


    console.log(
        '📤 ส่ง Card:',
        {
            title,
            desc,
            imageSize:
                image
                    ? image.length
                    : 0
        }
    );


    try {

        let res;


        // -------------------------------------------------
        // UPDATE
        // -------------------------------------------------

        if (id) {

            res =
                await fetch(
                    `/api/cards/${id}`,
                    {

                        method: 'PUT',

                        headers: {

                            'Content-Type':
                                'application/json'

                        },

                        body:
                            JSON.stringify(
                                payload
                            )

                    }
                );

        }


        // -------------------------------------------------
        // INSERT
        // -------------------------------------------------

        else {

            res =
                await fetch(
                    '/api/cards',
                    {

                        method: 'POST',

                        headers: {

                            'Content-Type':
                                'application/json'

                        },

                        body:
                            JSON.stringify(
                                payload
                            )

                    }
                );

        }


        const data =
            await res.json();


        console.log(
            '📥 Server Response:',
            data
        );


        if (
            !res.ok ||
            !data.success
        ) {

            throw new Error(
                data.message ||
                data.error ||
                'บันทึกการ์ดไม่สำเร็จ'
            );

        }


        alert(
            id
                ? '✅ แก้ไขการ์ดสำเร็จ'
                : '✅ เพิ่มการ์ดสำเร็จ'
        );


        closeCardModal();


        // Reload cards

        await fetchAndRenderCards();


    } catch (error) {

        console.error(
            '❌ Save Card Error:',
            error
        );


        alert(
            '❌ ' + error.message
        );

    }

}


// -----------------------------------------------------
// DELETE CARD
// -----------------------------------------------------

async function deleteCard(id) {

    if (
        !confirm(
            'คุณแน่ใจหรือไม่ที่จะลบการ์ดใบนี้?'
        )
    ) {

        return;

    }


    try {

        const res =
            await fetch(
                `/api/cards/${id}`,
                {
                    method: 'DELETE'
                }
            );


        const data =
            await res.json();


        if (
            !res.ok ||
            !data.success
        ) {

            throw new Error(
                data.message ||
                data.error ||
                'ลบการ์ดไม่สำเร็จ'
            );

        }


        alert(
            '✅ ลบการ์ดสำเร็จ'
        );


        await fetchAndRenderCards();


    } catch (error) {

        console.error(
            'Delete Card Error:',
            error
        );


        alert(
            '❌ ' + error.message
        );

    }

}


// =====================================================
// ESCAPE HTML
// ป้องกัน HTML injection จาก title / description
// =====================================================

function escapeHTML(value) {

    if (
        value === null ||
        value === undefined
    ) {

        return '';

    }


    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

}

// =====================================================
// REPAIR SYSTEM (ระบบแจ้งซ่อม)
// =====================================================

// 1. ฟังก์ชันดึงข้อมูลรายการแจ้งซ่อมมาแสดงในตาราง
async function fetchRepairPage() {
    const tbody = document.getElementById('repair-table-body'); // ตรวจสอบ ID ของ tbody ในไฟล์ repair.html ให้ตรงกัน
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-indigo-400">⏳ กำลังโหลดข้อมูล...</td></tr>`;
    


    try {
        const res = await fetch('/api/repairs');
        const data = await res.json();
        
        // รองรับกรณีข้อมูลอยู่ใน data.repairs หรือ data
        const repairs = Array.isArray(data) ? data : (data.repairs || []);

        let imageUrl = '';
        if (r.image_url) {
            try {
                const parsed = JSON.parse(r.image_url);
                imageUrl = Array.isArray(parsed) ? parsed[0] : r.image_url;
            } catch (e) {
                imageUrl = r.image_url; 
            }
         }

        if (repairs.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center py-8 text-gray-400 font-medium">
                        ไม่พบรายการแจ้งซ่อม
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = repairs.map(r => `
            <tr class="border-b border-gray-100 hover:bg-indigo-50/30 transition-colors">
                <td class="p-3.5 text-sm text-gray-600">${escapeHTML(r.created_at || '-')}</td>
                <td class="p-3.5 font-bold text-gray-800">${escapeHTML(r.room_number || '-')}</td>
                <td class="p-3.5 text-sm text-gray-500">${escapeHTML(r.issue || '-')}</td>
                <td class="p-3.5 text-sm text-center">
                    ${r.image_url 
                        ? `<a href="${imageUrl}" target="_blank" class="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-700 hover:bg-indigo-600 hover:text-white border border-indigo-100 hover:border-indigo-600 rounded-xl text-xs font-bold transition-all shadow-sm active:scale-95">
                            🖼️ ดูรูปภาพ
                        </a>`
                        : `<span class="text-gray-400 text-xs bg-gray-50 px-2.5 py-1 rounded-lg border border-gray-100">- ไม่มีรูปภาพ -</span>`
                    }
                </td>
                <td class="p-3.5 text-sm text-gray-700">${escapeHTML(r.tenant_name || '-')}</td>
                
                
                <!-- คอลัมน์สถานะ: เป็น Dropdown ให้กดเปลี่ยนได้ -->
                <td class="p-3.5">
                    <select onchange="updateRepairStatus(${r.id}, this.value)" 
                            class="bg-white border border-gray-300 text-gray-700 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block w-full p-1.5 shadow-sm">
                        <option value="รอดำเนินการ" ${r.status === 'รอดำเนินการ' ? 'selected' : ''}>รอดำเนินการ</option>
                        <option value="กำลังซ่อม" ${r.status === 'กำลังซ่อม' ? 'selected' : ''}>กำลังซ่อม</option>
                        <option value="เสร็จสิ้นแล้ว" ${r.status === 'เสร็จสิ้นแล้ว' ? 'selected' : ''}>เสร็จสิ้นแล้ว</option>
                    </select>
                </td>
                
                <!-- คอลัมน์จัดการ: มีแค่ปุ่มลบอย่างเดียว -->
                <td class="p-3.5 text-center">
                    <button onclick="deleteRepair(${r.id})" class="p-2 bg-rose-50 text-rose-600 hover:bg-rose-500 hover:text-white rounded-xl transition-all shadow-sm" title="ลบรายการ">
                        🗑️ ลบ
                    </button>
                </td>
            </tr>
        `).join('');

    } catch (error) {
        console.error('Fetch Repairs Error:', error);
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-rose-500 font-medium">❌ เกิดข้อผิดพลาดในการโหลดข้อมูล</td></tr>`;
    }
}

async function submitRepairForm(event) {
    if (event) event.preventDefault();

    // ดึงค่าตามฟิลด์ที่กำหนดโดยห้ามเปลี่ยนชื่อตัวแปรเหล่านี้เด็ดขาด
    const room_number = document.getElementById('repairRoomNumber')?.value.trim();
    const tenant_name = document.getElementById('repairTenantName')?.value.trim();
    const issue = document.getElementById('repairIssue')?.value.trim();
    const imageInput = document.getElementById('repairImage');
    
    // created_at จะถูกสร้างอัตโนมัติหรือดึงค่าเวลาปัจจุบัน
    const created_at = new Date().toISOString(); 

    if (!room_number || !issue) {
        alert('กรุณากรอกเลขห้องและรายละเอียดการแจ้งซ่อมให้ครบถ้วน');
        return;
    }

    let image_url = '';
    if (imageInput && imageInput.files[0]) {
        // แปลงรูปภาพเป็น Base64 หรืออัปโหลดตามระบบที่มีอยู่
        image_url = await fileToBase64(imageInput.files[0]);
    }

    // จัดเตรียม Payload โดยใช้ชื่อฟิลด์ตามที่กำหนดเป๊ะๆ
    const payload = {
        created_at,
        room_number,
        issue,
        image_url,
        tenant_name
    };

    try {
        const res = await fetch('/api/repairs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.message || 'ไม่สามารถบันทึกข้อมูลการแจ้งซ่อมได้');
        }

        // 🟢 แสดงข้อความแจ้งเตือนเมื่อบันทึกข้อมูลการแจ้งซ่อมเรียบร้อยแล้วตามต้องการ
        const resultDiv = document.getElementById('repair-result') || document.getElementById('repairResult');
        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="p-4 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl font-bold flex items-center gap-2 shadow-sm">
                    <span>✅</span> บันทึกข้อมูลการแจ้งซ่อมเรียบร้อยแล้ว
                </div>
            `;
        } else {
            alert('✅ บันทึกข้อมูลการแจ้งซ่อมเรียบร้อยแล้ว');
        }

        // รีเซ็ตฟอร์มหลังบันทึกสำเร็จ
        if (document.getElementById('repairForm')) {
            document.getElementById('repairForm').reset();
        }

        // โหลดรายการแจ้งซ่อมใหม่ (ถ้ามีฟังก์ชัน fetchRepairPage)
        if (typeof fetchRepairPage === 'function') {
            await fetchRepairPage();
        }

    } catch (error) {
        console.error('Repair Error:', error);
        alert('❌ เกิดข้อผิดพลาด: ' + error.message);
    }
}
// 2. ฟังก์ชันอัปเดตสถานะเข้าฐานข้อมูล (Neon) ทันทีที่เปลี่ยน Dropdown
async function updateRepairStatus(id, newStatus) {
    try {
        const res = await fetch(`/api/repairs/${id}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.message || 'ไม่สามารถอัปเดตสถานะได้');
        }
        
        // (ตัวเลือกเสริม) แสดงข้อความแจ้งเตือนเมื่อบันทึกสำเร็จ
        alert('✅ อัปเดตสถานะการแจ้งซ่อมเรียบร้อยแล้ว');
        
    } catch (error) {
        console.error('Update Repair Status Error:', error);
        alert('❌ ' + error.message);
        await fetchRepairPage(); // ดึงข้อมูลใหม่เพื่อรีเซ็ตค่า Dropdown กลับเป็นค่าเดิมหากเกิด Error
    }
}

// 3. ฟังก์ชันลบการ์ด/รายการแจ้งซ่อม
async function deleteRepair(id) {
    if (!confirm('คุณแน่ใจหรือไม่ที่จะลบรายการแจ้งซ่อมนี้? \n(ไม่สามารถกู้คืนได้)')) {
        return;
    }

    try {
        const res = await fetch(`/api/repairs/${id}`, {
            method: 'DELETE'
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.message || 'เกิดข้อผิดพลาดในการลบรายการ');
        }

        alert('✅ ลบรายการแจ้งซ่อมสำเร็จ');
        await fetchRepairPage(); // โหลดตารางใหม่หลังลบเสร็จ

    } catch (error) {
        console.error('Delete Repair Error:', error);
        alert('❌ ' + error.message);
    }
}


// --- 3. ข่าวสารและประกาศ ---
async function fetchAnnouncementPage() {
    try {
        const res = await fetch('/api/announcements');
        const data = await res.json();
        let html = '';
        (data.announcements || []).forEach(a => {
            html += `<div class="bg-white p-4 rounded-lg border shadow-sm mb-3">
                <h4 class="font-bold text-lg text-indigo-700">${escapeHTML(a.title)}</h4>
                <p class="text-gray-600 mt-1">${escapeHTML(a.content)}</p>
                <span class="text-xs text-gray-400 mt-2 block">ประกาศเมื่อ: ${new Date(a.created_at).toLocaleString()}</span>
            </div>`;
        });
        const container = document.getElementById('announcement-list');
        if (container) container.innerHTML = html || '<p class="text-gray-400">ยังไม่มีประกาศ</p>';
    } catch (err) { console.error(err); }
}

async function postAnnouncement(e) {
    e.preventDefault();
    const title = document.getElementById('annTitle').value;
    const content = document.getElementById('annContent').value;

    await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content })
    });
    alert('📢 Broadcast ประกาศไปยังแอปผู้เช่าทุกคนแล้ว');
    document.getElementById('ann-form').reset();
    fetchAnnouncementPage();
}

// --- 4. เซ็นสัญญาออนไลน์ ---
async function fetchContractPage() {
    try {
        const res = await fetch('/api/contracts');
        const data = await res.json();
        let rows = '';
        (data.contracts || []).forEach(c => {
            rows += `
                <tr class="border-b">
                    <td class="p-3">ห้อง ${escapeHTML(c.room_number)}</td>
                    <td class="p-3">${escapeHTML(c.tenant_name)}</td>
                    <td class="p-3"><span class="px-2 py-1 rounded text-xs ${c.status === 'Signed' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}">${c.status === 'Signed' ? 'เซ็นสัญญาแล้ว (ออนไลน์)' : 'รอลงลายมือชื่อ'}</span></td>
                    <td class="p-3 text-center">
                        ${c.status !== 'Signed' ? `<button onclick="simulateTenantSign(${c.id})" class="bg-blue-600 text-white px-3 py-1 rounded text-xs">✍️ จำลองผู้เช่าเซ็นผ่านลิงก์</button>` : '<span class="text-green-600 font-semibold">สมบูรณ์</span>'}
                    </td>
                </tr>`;
        });
        const tbody = document.getElementById('contract-table-body');
        if (tbody) tbody.innerHTML = rows || '<tr><td colspan="4" class="text-center p-4 text-gray-400">ยังไม่มีสัญญาเช่า</td></tr>';
    } catch (err) { console.error(err); }
}

async function simulateTenantSign(id) {
    const signature = "Digital_Signature_Verified_" + Math.random().toString(36).substring(7);
    await fetch(`/api/contracts/${id}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature })
    });
    alert('✅ ผู้เช่าลงลายมือชื่อออนไลน์สำเร็จ บันทึกเข้าแฟ้มทันทีโดยไม่ต้องปริ้นกระดาษ!');
    fetchContractPage();
}

// =====================================================
// ROOM DETAIL & LIGHTBOX IMAGE GALLERY SYSTEM
// =====================================================

// ตัวแปรสำหรับจัดการสถานะ Gallery รูปภาพ
let modalGalleryImages = [];
let currentModalImageIndex = 0;

function showRoomDetailModal(roomId) {
    // หาข้อมูลห้องจาก Array dashboardRoomsData
    const room = dashboardRoomsData.find(r => Number(r.id) === Number(roomId));
    if (!room) return;

    // อ่านข้อมูลรูปภาพ (ถ้ามี)
    modalGalleryImages = [];
    if (room.image_data) {
        try {
            const parsed = JSON.parse(room.image_data);
            modalGalleryImages = Array.isArray(parsed) ? parsed : [room.image_data];
        } catch (e) {
            modalGalleryImages = [room.image_data];
        }
    }

    // กำหนดสีและข้อความสถานะ
    let statusBg = 'bg-orange-100 text-orange-700 border-orange-200';
    let statusText = '🟠 ห้องว่าง';
    if (room.status === 'Occupied') {
        statusBg = 'bg-emerald-100 text-emerald-800 border-emerald-200';
        statusText = '🟢 มีผู้เช่า';
    } else if (room.status === 'Booked') {
        statusBg = 'bg-blue-100 text-blue-800 border-blue-200';
        statusText = '📌 จองแล้ว';
    }

    // ตรวจสอบหรือสร้าง Element สำหรับ Modal Container
    let modalOverlay = document.getElementById('room-detail-modal');
    if (!modalOverlay) {
        modalOverlay = document.createElement('div');
        modalOverlay.id = 'room-detail-modal';
        document.body.appendChild(modalOverlay);
    }

    // สร้าง Gallery รูปภาพ (เมื่อคลิกที่รูปจะเปิด Lightbox ขยายใหญ่)
    const imageGalleryHTML = modalGalleryImages.length > 0 
        ? `<div class="mb-5">
            <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-bold text-gray-500 uppercase tracking-wider">📷 รูปภาพห้องพัก (${modalGalleryImages.length} รูป)</span>
                <span class="text-xs text-indigo-600 font-semibold">คลิกที่รูปเพื่อขยาย</span>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-60 overflow-y-auto p-1.5 bg-gray-50 rounded-2xl border border-gray-100">
                ${modalGalleryImages.map((img, idx) => `
                    <div onclick="openImageLightbox(${idx})" class="relative group cursor-pointer overflow-hidden rounded-xl border border-gray-200 shadow-xs h-28 bg-black/5">
                        <img src="${img}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300">
                        <div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-lg">
                            🔍
                        </div>
                    </div>
                `).join('')}
            </div>
           </div>`
        : `<div class="mb-5 py-6 bg-gray-50 border border-dashed border-gray-200 rounded-2xl text-center text-gray-400 text-sm">
            📷 ไม่มีรูปภาพประกอบห้องพัก
           </div>`;

    // แจ้งเตือนเตรียมย้ายออก
    const moveOutHTML = room.is_moving_out 
        ? `<div class="mt-4 p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm flex items-center gap-2 font-bold">
            <span class="text-xl">📦</span>
            <div>
                <div>เตรียมย้ายออก</div>
                <div class="text-xs font-normal text-rose-600">กำหนดวันที่: ${escapeHTML(room.move_out_day || '-')} ${escapeHTML(room.move_out_month || '')}</div>
            </div>
           </div>`
        : '';

    const tenantName = room.status === 'Occupied' ? (room.tenant && room.tenant !== '-' ? room.tenant : 'ไม่ระบุชื่อ') : (room.status === 'Booked' ? 'รอดำเนินการ' : '-');

    // โครงสร้าง Pop-up Detail Modal
    modalOverlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4 transition-all duration-300';
    modalOverlay.innerHTML = `
        <div class="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl border border-gray-100 transform transition-all duration-300 scale-100">
            <!-- Modal Header -->
            <div class="bg-gradient-to-r from-indigo-600 to-purple-600 p-6 text-white relative">
                <button onclick="closeRoomDetailModal()" class="absolute top-5 right-5 w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center transition-colors text-lg font-bold">
                    ✕
                </button>
                <div class="flex items-center gap-2 mb-2">
                    <span class="px-3 py-1 bg-white/20 backdrop-blur-md rounded-xl text-xs font-bold border border-white/20">
                        ${escapeHTML(room.dormitory_name || 'ไม่ระบุกลุ่มหอพัก')}
                    </span>
                    <span class="px-3 py-1 rounded-xl text-xs font-bold ${statusBg}">
                        ${statusText}
                    </span>
                </div>
                <h2 class="text-2xl font-black">ห้อง ${escapeHTML(room.number)}</h2>
            </div>

            <!-- Modal Body -->
            <div class="p-6 max-h-[80vh] overflow-y-auto">
                ${imageGalleryHTML}

                <div class="space-y-3 bg-gray-50/80 p-4 rounded-2xl border border-gray-100 text-sm">
                    <div class="flex justify-between items-center py-1 border-b border-gray-200/60">
                        <span class="text-gray-500">👤 ผู้เช่าปัจจุบัน:</span>
                        <span class="font-bold text-gray-800">${escapeHTML(tenantName)}</span>
                    </div>
                    <div class="flex justify-between items-center py-1 border-b border-gray-200/60">
                        <span class="text-gray-500">💰 ค่าเช่ารายเดือน:</span>
                        <span class="font-extrabold text-indigo-600 text-base">${Number(room.price || 0).toLocaleString()} ฿</span>
                    </div>
                    <div class="flex justify-between items-center py-1">
                        <span class="text-gray-500">🏢 ประเภทห้องพัก:</span>
                        <span class="font-medium text-gray-700 bg-white px-2.5 py-0.5 rounded-lg border border-gray-200">${escapeHTML(room.type || 'Standard')}</span>
                    </div>
                </div>

                ${moveOutHTML}
            </div>

            <!-- Modal Footer -->
            <div class="p-4 bg-gray-50 border-t border-gray-100 flex justify-end">
                <button onclick="closeRoomDetailModal()" class="px-5 py-2.5 bg-gray-200 text-gray-700 rounded-xl font-bold hover:bg-gray-300 transition-colors text-sm">
                    ปิดหน้าต่าง
                </button>
            </div>
        </div>
    `;
}

function closeRoomDetailModal() {
    const modalOverlay = document.getElementById('room-detail-modal');
    if (modalOverlay) {
        modalOverlay.remove();
    }
}

// -----------------------------------------------------
// LIGHTBOX FULLSCREEN ZOOM & NAVIGATION
// -----------------------------------------------------

function openImageLightbox(index) {
    if (!modalGalleryImages || modalGalleryImages.length === 0) return;
    currentModalImageIndex = index;

    let lightboxOverlay = document.getElementById('image-lightbox-modal');
    if (!lightboxOverlay) {
        lightboxOverlay = document.createElement('div');
        lightboxOverlay.id = 'image-lightbox-modal';
        document.body.appendChild(lightboxOverlay);
    }

    lightboxOverlay.className = 'fixed inset-0 bg-black/90 backdrop-blur-md z-[60] flex flex-col items-center justify-between p-4 sm:p-6 transition-all duration-300';
    
    lightboxOverlay.innerHTML = `
        <!-- Lightbox Header -->
        <div class="w-full flex justify-between items-center text-white z-10 max-w-5xl">
            <span id="lightbox-counter" class="text-sm font-bold bg-white/10 px-3 py-1.5 rounded-full border border-white/10">
                ${currentModalImageIndex + 1} / ${modalGalleryImages.length}
            </span>
            <button onclick="closeImageLightbox()" class="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center text-xl font-bold transition-all hover:scale-105 active:scale-95">
                ✕
            </button>
        </div>

        <!-- Lightbox Main Content -->
        <div class="relative flex-1 w-full max-w-5xl flex items-center justify-center my-2 select-none">
            ${modalGalleryImages.length > 1 ? `
                <!-- Navigation Prev Button -->
                <button onclick="navigateLightbox(-1)" class="absolute left-2 sm:left-4 z-20 w-12 h-12 rounded-full bg-black/50 hover:bg-black/80 border border-white/20 text-white flex items-center justify-center text-2xl transition-all hover:scale-110 active:scale-90 shadow-lg">
                    ❮
                </button>
            ` : ''}

            <!-- Zoomed Image -->
            <img id="lightbox-image" src="${modalGalleryImages[currentModalImageIndex]}" class="max-h-[75vh] max-w-full object-contain rounded-2xl shadow-2xl transition-all duration-300 transform scale-100">

            ${modalGalleryImages.length > 1 ? `
                <!-- Navigation Next Button -->
                <button onclick="navigateLightbox(1)" class="absolute right-2 sm:right-4 z-20 w-12 h-12 rounded-full bg-black/50 hover:bg-black/80 border border-white/20 text-white flex items-center justify-center text-2xl transition-all hover:scale-110 active:scale-90 shadow-lg">
                    ❯
                </button>
            ` : ''}
        </div>

        <!-- Lightbox Thumbnails Strip -->
        ${modalGalleryImages.length > 1 ? `
            <div class="flex gap-2 overflow-x-auto max-w-full p-2 bg-white/5 rounded-2xl border border-white/10 z-10 select-none">
                ${modalGalleryImages.map((img, i) => `
                    <img id="lightbox-thumb-${i}" onclick="jumpToLightboxImage(${i})" src="${img}" class="w-14 h-14 object-cover rounded-xl cursor-pointer border-2 transition-all ${i === currentModalImageIndex ? 'border-indigo-500 scale-105 opacity-100' : 'border-transparent opacity-50 hover:opacity-100'}">
                `).join('')}
            </div>
        ` : '<div></div>'}
    `;

    // ลงทะเบียนการกดปุ่มบนคีย์บอร์ด (Keyboard Shortcuts)
    document.addEventListener('keydown', handleLightboxKeyDown);
}

function closeImageLightbox() {
    const lightboxOverlay = document.getElementById('image-lightbox-modal');
    if (lightboxOverlay) {
        lightboxOverlay.remove();
    }
    document.removeEventListener('keydown', handleLightboxKeyDown);
}

function navigateLightbox(direction) {
    if (!modalGalleryImages || modalGalleryImages.length <= 1) return;
    
    currentModalImageIndex = (currentModalImageIndex + direction + modalGalleryImages.length) % modalGalleryImages.length;
    updateLightboxUI();
}

function jumpToLightboxImage(index) {
    currentModalImageIndex = index;
    updateLightboxUI();
}

function updateLightboxUI() {
    const imgEl = document.getElementById('lightbox-image');
    const counterEl = document.getElementById('lightbox-counter');
    
    if (imgEl) {
        imgEl.src = modalGalleryImages[currentModalImageIndex];
    }
    if (counterEl) {
        counterEl.innerText = `${currentModalImageIndex + 1} / ${modalGalleryImages.length}`;
    }

    // อัปเดตสถานะขอบรูปเล็กลด้านล่าง (Active Thumbnail)
    modalGalleryImages.forEach((_, i) => {
        const thumb = document.getElementById(`lightbox-thumb-${i}`);
        if (thumb) {
            if (i === currentModalImageIndex) {
                thumb.className = 'w-14 h-14 object-cover rounded-xl cursor-pointer border-2 border-indigo-500 scale-105 opacity-100 transition-all';
            } else {
                thumb.className = 'w-14 h-14 object-cover rounded-xl cursor-pointer border-2 border-transparent opacity-50 hover:opacity-100 transition-all';
            }
        }
    });
}

function handleLightboxKeyDown(e) {
    if (e.key === 'ArrowLeft') {
        navigateLightbox(-1);
    } else if (e.key === 'ArrowRight') {
        navigateLightbox(1);
    } else if (e.key === 'Escape') {
        closeImageLightbox();
    }
}

// ผูกฟังก์ชันเข้ากับ Window เพื่อให้ HTML เรียกใช้งานได้
window.showRoomDetailModal = showRoomDetailModal;
window.closeRoomDetailModal = closeRoomDetailModal;
window.openImageLightbox = openImageLightbox;
window.closeImageLightbox = closeImageLightbox;
window.navigateLightbox = navigateLightbox;
window.jumpToLightboxImage = jumpToLightboxImage;

// =====================================================
// ทำให้ Function เรียกได้จาก onclick ใน HTML
// =====================================================

window.switchTab =
    switchTab;

window.toggleTenantInput =
    toggleTenantInput;

window.addRoom =
    addRoom;

window.generateBills =
    generateBills;

window.verifySlip =
    verifySlip;

window.openCardModal =
    openCardModal;

window.closeCardModal =
    closeCardModal;

window.previewCardImage =
    previewCardImage;

window.saveCard =
    saveCard;

window.deleteCard =
    deleteCard;

window.addRoom = saveRoom;
window.editRoom = editRoom;
window.resetRoomForm = resetRoomForm;
window.saveRoom = saveRoom;
window.deleteRoom = deleteRoom;
window.updateRepairStatus = updateRepairStatus;
window.addParcel = addParcel;
window.markParcelPicked = markParcelPicked;
window.postAnnouncement = postAnnouncement;
window.simulateTenantSign = simulateTenantSign;
window.fetchDormitories = fetchDormitories;
window.addDormitory = addDormitory;
window.editDormitory = editDormitory;
window.deleteDormitory = deleteDormitory;
window.fetchRoomsForBilling = fetchRoomsForBilling;
window.fetchBillingOptions = fetchBillingOptions;
window.toggleOptFee = toggleOptFee;
window.addOptFeeRow = addOptFeeRow;
window.removeOptFeeRow = removeOptFeeRow;
window.fetchAndRenderCards = fetchAndRenderCards;
window.fetchTenants = fetchTenants;
window.fetchExportedBills = fetchExportedBills;
window.previewRoomImage = previewRoomImage;
window.removeRoomImage = removeRoomImage;