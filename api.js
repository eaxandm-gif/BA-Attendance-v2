(() => {
  'use strict';

  async function request(action, payload = {}) {
    if (!window.BA_CONFIG) {
      throw new Error('ไม่พบ BA_CONFIG กรุณาตรวจไฟล์ config.js');
    }

    const url = BA_CONFIG.EDGE_FUNCTION_URL;
    if (!url) {
      throw new Error('ยังไม่ได้ตั้งค่า EDGE_FUNCTION_URL');
    }

    const idToken = window.liff?.getIDToken?.();
    if (!idToken) {
      throw new Error('ไม่พบ LINE ID Token กรุณาปิดแล้วเปิด LIFF ใหม่');
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Number(BA_CONFIG.REQUEST_TIMEOUT_MS || 30000)
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ action, payload }),
        signal: controller.signal
      });

      const text = await response.text();
      let result = {};
      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (${response.status})`);
      }

      if (!response.ok || result.success === false) {
        throw new Error(result.message || `เกิดข้อผิดพลาด HTTP ${response.status}`);
      }

      return Object.prototype.hasOwnProperty.call(result, 'data')
        ? result.data
        : result;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('ระบบใช้เวลาตอบกลับนานเกินไป กรุณาลองใหม่');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  window.BA_API = Object.freeze({ request });
})();
