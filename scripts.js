import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Centralized Supabase configuration
export const SUPABASE_URL = 'https://eefhkfhccqbxvehzdljz.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVlZmhrZmhjY3FieHZlaHpkbGp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxMzQ5MzEsImV4cCI6MjEwMDcxMDkzMX0.2PR60mHhqNbt5Xfed05YH-fo56N1-0kTEXW5L_HQHgU';

// Shared Supabase client instance
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Initialize a live updating UTC clock in any target element ID
 */
export function initTerminalClock(elementId) {
    const clockEl = document.getElementById(elementId);
    if (!clockEl) return;

    function updateClock() {
        const now = new Date();
        clockEl.innerText = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    }

    updateClock();
    setInterval(updateClock, 1000);
}

/**
 * Display a top-level system notification banner
 */
export function showTopNotification(message) {
    let banner = document.getElementById('trb-top-popup');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'trb-top-popup';
        banner.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%;
            background-color: #800000; color: #ffffff;
            border-bottom: 3px double #ff3333; padding: 12px 16px;
            font-family: 'Courier New', Courier, monospace; font-size: 13px;
            font-weight: bold; text-align: center; z-index: 99999;
            box-sizing: border-box; text-transform: uppercase;
        `;
        document.body.prepend(banner);
    }
    banner.innerText = `⚠️ SYSTEM ALERT: ${message}`;
}

export async function verifyOperatorClearance() {
    const CACHE_KEY = 'trb_current_login';
    const MAX_AGE_MS = 10 * 60 * 1000;

    const failAndRedirect = async (errorMessage) => {
        showTopNotification(errorMessage);
        localStorage.removeItem(CACHE_KEY);
        await new Promise(resolve => setTimeout(resolve, 2000));
        window.location.href = `index.html?reason=${encodeURIComponent(errorMessage)}`;
        return { success: false, error: errorMessage };
    };

    const rawData = localStorage.getItem(CACHE_KEY);
    if (!rawData) return await failAndRedirect("No active session telemetry found. Redirecting...");

    let sessionData;
    try { sessionData = JSON.parse(rawData); } catch (e) { return await failAndRedirect("Malformed session cache detected."); }

    const { username, badgeID, timestamp } = sessionData;
    if (!username || !badgeID || !timestamp) return await failAndRedirect("Incomplete authorization parameters.");

    if (Date.now() - new Date(timestamp).getTime() > MAX_AGE_MS) {
        return await failAndRedirect("Authentication token expired (> 10 mins). Re-verification required.");
    }

    try {
        // Call the secure RPC function instead of querying the locked users table directly
        const { data: profileData, error } = await supabase.rpc('get_operator_profile', {
            input_username: username,
            input_badge: badgeID
        });

        const data = profileData && profileData.length > 0 ? profileData[0] : null;

        if (error || !data) return await failAndRedirect("Credentials mismatched in bureau registry.");
        if (data.status !== 'ACTIVE') return await failAndRedirect(`Operator status suspended [${data.status}].`);

        return { success: true, clearance: data.clearance, username, badgeID };
    } catch (err) {
        return await failAndRedirect(`Critical authorization failure: ${err.message}`);
    }
}


/**
 * Read the operator's CURRENT clearance from the database (no redirects).
 * Returns it lower-cased, e.g. 'user', 'admin', 'a'.
 * Throws an Error with a readable message if there is no valid session.
 */
export async function getOperatorClearance() {
    const raw = localStorage.getItem('trb_current_login');
    if (!raw) throw new Error('NO ACTIVE SESSION');

    let session;
    try { session = JSON.parse(raw); } catch (e) { throw new Error('MALFORMED SESSION'); }

    const { username, badgeID } = session;
    if (!username || !badgeID) throw new Error('INCOMPLETE SESSION');

    const { data: profileData, error } = await supabase.rpc('get_operator_profile', {
        input_username: username,
        input_badge: badgeID
    });

    const data = profileData && profileData.length > 0 ? profileData[0] : null;
    if (error || !data) throw new Error('CREDENTIALS NOT FOUND');
    if (data.status !== 'ACTIVE') throw new Error(`OPERATOR STATUS: ${data.status}`);

    return String(data.clearance || 'USER').toLowerCase();
}

/**
 * Submit the puzzle answer. The answer is checked on the server (Supabase),
 * which also promotes the operator to clearance 'A' if it is correct.
 * Resolves true if correct, false if wrong. Throws on errors / not allowed.
 */
export async function submitTensorCollapseFlag(flag) {
    const raw = localStorage.getItem('trb_current_login');
    if (!raw) throw new Error('NO ACTIVE SESSION');
    const { username, badgeID } = JSON.parse(raw);

    const { data, error } = await supabase.rpc('solve_tensor_collapse', {
        input_username: username,
        input_badge: badgeID,
        submitted_flag: flag
    });
    if (error) throw new Error(error.message);
    return data === true;
}

async function fetchModuleRecords(directoryName) {
    try {
        const session = await verifyOperatorClearance();
        if (!session || !session.success) return [];

        const userTier = session.clearance.toUpperCase();

        // Call the dedicated server-side RPC function securely
        const { data, error } = await supabase.rpc('fetch_module_records', {
            directory_name: directoryName,
            player_clearance: userTier
        });

        if (error) {
            console.error(`[SUPABASE-FETCH-FAIL]`, error.message);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error(`[SUPABASE-CRITICAL-FAIL] Unable to query filesystem repository:`, err);
        return [];
    }
}

/**
 * Render standard registry table views
 */
export async function renderStandardRegistryTable(directoryName, targetElementId) {
    const container = document.getElementById(targetElementId);
    if (!container) return;

    try {
        const records = await fetchModuleRecords(directoryName);

        if (!records || records.length === 0) {
            container.innerHTML = `
                <div style="padding: 12px; border: 1px dashed #808080;">
                    <p class="regulatory-text" style="color: #ff0000; margin: 0;">
                        [CLEARANCE INSUFFICIENT FOR DIRECTORY: /${directoryName.toUpperCase()}/]
                    </p>
                </div>`;
            return;
        }

        let html = `
            <table class="data-table">
                <thead>
                    <tr>
                        <th>ISSUE / ARCHIVE ID</th>
                        <th>RECORD / FILE NAME</th>
                        <th>SOURCE DIVISION</th>
                        <th>FORMAT</th>
                        <th>CLEARANCE</th>
                        <th>ACTION / DETAILS</th>
                    </tr>
                </thead>
                <tbody>`;

        records.forEach(item => {
            html += `
                <tr>
                    <td>${item.archive_issue_id || '---'}</td>
                    <td><span class="file-name">${item.record_file_name}</span></td>
                    <td>${item.source_division}</td>
                    <td>${item.data_format || 'DIGITAL'}</td>
                    <td><span class="badge-${item.access_clearance.toLowerCase()}">${item.access_clearance}</span></td>
                    <td>
                        <a href="${item.url || '#'}" class="action-btn" title="${item.description || ''}">ACCESS PAYLOAD</a>
                    </td>
                </tr>`;
        });

        html += `</tbody></table>`;
        container.innerHTML = html;

    } catch (err) {
        console.error("[TABLE-RENDER-FAIL]", err);
    }
}

/**
 * Text loader for reading static local directive payload files
 */
export async function loadMissionText(targetElementId) {
    const targetEl = document.getElementById(targetElementId);
    if (!targetEl) return;

    const session = await verifyOperatorClearance();
    if (!session || !session.success) return;

    try {
        const response = await fetch('mission.txt');

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: Failed to locate mission directive file.`);
        }

        const text = await response.text();
        targetEl.replaceChildren();

        const pre = document.createElement("pre");
        pre.className = "regulatory-text";
        pre.style.whiteSpace = "pre-wrap";
        pre.style.fontFamily = "inherit";
        pre.style.margin = "0";
        pre.textContent = text;

        targetEl.appendChild(pre);

    } catch (err) {
        console.error("[LOAD-MISSION-FAIL]", err);
        targetEl.innerHTML = `<p style="color: #ff0000; font-weight: bold; margin: 0;">
            SEC_ERROR: Unable to retrieve local directive payload [${err.message}].
        </p>`;
    }
}

export function initRotatingFavicon(intervalMs = 120, stepAngle = 1) {
    let faviconLink = document.getElementById('dynamic-favicon');
    if (!faviconLink) {
        faviconLink = document.createElement('link');
        faviconLink.id = 'dynamic-favicon';
        faviconLink.rel = 'icon';
        document.head.appendChild(faviconLink);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');

    let angle = 0;

    function renderFrame() {
        ctx.clearRect(0, 0, 32, 32);

        ctx.save();
        // Translate to canvas origin center
        ctx.translate(16, 16);
        ctx.rotate((angle * Math.PI) / 180);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '22px serif';
        ctx.fillText('⌛', 0, 2);
        ctx.restore();

        faviconLink.href = canvas.toDataURL('image/png');

        // Increment by small step for a gentle turn
        angle = (angle + stepAngle) % 360;
    }

    // Call once immediately, then start steady interval
    renderFrame();
    return setInterval(renderFrame, intervalMs);
}
/**
 * Log a discrepancy event to Supabase
 */
export async function logDiscrepancy(supabaseClient, player, eventType, details = '') {
    if (!supabaseClient) return;

    try {
        await supabaseClient.from('discrepancies').insert([
            {
                operator_name: player?.username || player?.character_name || 'ANONYMOUS',
                badge_id: player?.badge_id || player?.activeBadge || 'UNKNOWN',
                event_type: eventType,
                details: details,
                timestamp: new Date().toISOString()
            }
        ]);
    } catch (err) {
        console.error('Failed to log event:', err);
    }
}

export async function loadDiscrepancies() {
    const tbody = document.getElementById('discrepancies-table-body');
    const badgeCount = document.getElementById('discrepancy-badge-count');

    const { data: logs, error } = await supabase.rpc('get_discrepancy_feed');

    if (error) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="color: #ef4444;">ERR_LOG_FETCH_FAILED: ${error.message}</td></tr>`;
        if (badgeCount) badgeCount.innerText = 'ERR';
        return;
    }

    if (!logs || logs.length === 0) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #888;">NO ACTIVE DISCREPANCIES LOGGED. TIMELINE SECURE.</td></tr>`;
        if (badgeCount) badgeCount.innerText = '0';
        return;
    }

    if (badgeCount) {
        badgeCount.innerText = logs.length;
    }

    if (tbody) {
        tbody.innerHTML = '';
        logs.forEach(log => {
            const tr = document.createElement('tr');
            const formattedDate = log.timestamp ? new Date(log.timestamp).toISOString().replace('T', ' ').substring(0, 19) : '';

            tr.innerHTML = `
                <td style="font-size: 0.8rem; color: #aaa;">${formattedDate} UTC</td>
                <td> [${log.alias || 'UNKNOWN'}]</td>
                <td style="font-weight: bold; color: #bbb;">${log.event_type}</td>
                <td style="font-size: 0.85rem;">${log.details || ''}</td>
            `;
            tbody.appendChild(tr);
        });
    }
}
