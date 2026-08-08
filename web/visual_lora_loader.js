import { app } from "../../scripts/app.js";

import { CONFIG } from "./config.js";
console.log("[Neurad] VisualLora extension loaded.");

// ============================================================================
// LOCAL STORAGE CACHE WITH DISK BACKUP
// ============================================================================
// Key used to identify our data in the browser's LocalStorage.
const STORAGE_KEY = "neurad_lora_cache_v1";

// Global state variable to track the current Drag & Drop operation.
// Possible values: null, 'tab-reorder', or 'lora-card'
let neuradDragState = null;

/**
 * LocalCache Module
 * 
 * Manages a dual-layer persistence system for LoRA metadata:
 * 1. Primary: Browser LocalStorage (Fast access, session persistence).
 * 2. Backup: Server-side Disk Storage (Disaster recovery if LocalStorage is cleared).
 * 
 * Logic:
 * - On Load: Reads from LocalStorage. If empty, attempts to restore from Server Disk.
 * - On Save: Writes to LocalStorage immediately, then debounces a request to save to Server Disk.
 */
const LocalCache = {
    data: {},
    saveTimeout: null,

    /**
     * One-time migration: earlier versions mirrored the full cache into
     * browser LocalStorage on every write, which grows unbounded as the
     * LoRA library grows and can eat into the browser's per-origin storage
     * quota (shared with ComfyUI's own workflow-draft autosave), causing
     * "Failed to save workflow draft" errors.
     * The on-disk backup (via /neurad/*-localstorage-backup) is the
     * source of truth now, so we just purge the stale LocalStorage key
     * if it's still hanging around from before this change.
     */
    load() {
        try {
            if (localStorage.getItem(STORAGE_KEY) !== null) {
                localStorage.removeItem(STORAGE_KEY);
                console.log("[Neurad] Removed legacy LocalStorage cache (now using on-disk cache only).");
            }
        } catch (e) { console.error("[Neurad] LocalStorage cleanup error", e); }
    },

    /**
     * Persists current in-memory data to disk (debounced).
     * No longer mirrors to LocalStorage — the on-disk backup, read fresh
     * via restoreFromDisk() at startup, is the single persistence layer.
     */
    save() {
        this.triggerDiskSave();
    },

    /** Retrieves a specific item from the cache by key. */
    get(key) { return this.data[key] || null; },

    /**
     * Removes an item from the cache and triggers a save.
     * Used to purge stale metadata for LoRAs that no longer exist on disk.
     * @param {string} key - The LoRA path identifier.
     */
    delete(key) {
        if (Object.prototype.hasOwnProperty.call(this.data, key)) {
            delete this.data[key];
            this.save();
        }
    },

    /**
     * Updates an item in the cache and triggers a save.
     * @param {string} key - The LoRA path identifier.
     * @param {object} value - The metadata object to store.
     */
    set(key, value) {
        this.data[key] = value;
        this.save();
    },

    /**
     * Debounced server synchronization.
     * Sends the current cache state to the Python backend to be written to the physical disk.
     * Clears any pending timeout to ensure only the latest state is saved.
     */
    triggerDiskSave() {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
            fetch('/neurad/save-localstorage-backup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.data)
            }).catch(e => console.warn("[Neurad] Disk backup failed", e));
        }, 1000); 
    },

    /**
     * Force restores data from the server disk backup.
     * Used when LocalStorage is empty or corrupted.
     * Overwrites the current memory and LocalStorage with the server's version.
     */
    async restoreFromDisk() {
        console.log("[Neurad] Starting restore process...");
        
        try {
            const resp = await fetch('/neurad/load-localstorage-backup');
            const result = await resp.json();
            
            if (result.success && result.data && Object.keys(result.data).length > 0) {
                // Load directly into in-memory cache. Disk is the sole
                // persistence layer now, so there's nothing to sync back
                // to LocalStorage.
                this.data = result.data;

                console.log(`[Neurad] SUCCESS: Loaded ${Object.keys(this.data).length} items from disk cache.`);
            } else {
                console.log("[Neurad] No disk backup found.");
            }
        } catch (e) { 
            console.error("[Neurad] Disk restore failed critically", e); 
        }
    }
};

// Initialize cache immediately upon script load
LocalCache.load();

// ============================================================================
// GLOBAL IMAGE CACHE
// ============================================================================
/**
 * NeuradImageCache
 * 
 * An in-memory cache for HTMLImageElement objects to prevent redundant network requests
 * and improve rendering performance when scrolling through large LoRA catalogs.
 * 
 * Strategy: FIFO (First-In-First-Out) eviction when the cache exceeds maxItems.
 * Note: Images are cloned when retrieved to avoid detaching them from the cache if they are added to the DOM.
 */
const NeuradImageCache = {
    store: {}, // Key: Image URL, Value: Cloned HTMLImageElement
    maxItems: 800, // Limit to prevent memory leaks
    
    /** Retrieves a cached image element, or null if not found. */
    get(url) {
        return this.store[url] || null;
    },
    
    /**
     * Stores a loaded image element.
     * If the cache is full, the oldest entry is removed.
     * The element is cloned before storage to preserve the original reference.
     */
    set(url, imgElement) {
        const keys = Object.keys(this.store);
        if (keys.length >= this.maxItems) {
            delete this.store[keys[0]];
        }
        this.store[url] = imgElement.cloneNode(true); 
    }
};

// ============================================================================
// GLOBAL STYLES INJECTION
// ============================================================================
/**
 * Injects global CSS styles required for the extension's UI components.
 * Specifically handles Tab styling (active/inactive states) and custom Scrollbars.
 * Ensures styles are only injected once by checking for the existing style ID.
 */
function injectGlobalStyles() {
    if (document.getElementById('neurad-global-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'neurad-global-styles';
    style.textContent = `
        /* Tab Styles */
        .neurad-tab { /* inactive */
            display: inline-flex;
			align-items: center;
			gap: 6px;
            padding: 7px 10px 6px 10px;
			font-size: 13px;
			font-weight: 300;
            cursor: pointer;
			border-radius: 4px;
            margin: 4px 2px 4px 0px;
            background: transparent; color: ${CONFIG.COLORS.text_faded}; z-index: 1; white-space: nowrap;
        }
        .neurad-tab:hover { background: ${CONFIG.COLORS.bg_tab_hover}; color: ${CONFIG.COLORS.text_main}; }
        .neurad-tab.active { background: ${CONFIG.COLORS.bg_tab_active} !important; color: ${CONFIG.COLORS.text_main}; font-weight: 300; z-index: 10; }
        
        /* Image Scrollbar */
        .neurad-image-scroll::-webkit-scrollbar { height: 8px; }
        .neurad-image-scroll::-webkit-scrollbar-track { background: ${CONFIG.COLORS.bg_dark}; }
        .neurad-image-scroll::-webkit-scrollbar-thumb { background: ${CONFIG.COLORS.bg_button}; border-radius: 4px; }
        .neurad-image-scroll::-webkit-scrollbar-thumb:hover { background: ${CONFIG.COLORS.bg_button_hover}; }
    `;
    document.head.appendChild(style);
}
injectGlobalStyles();

// ============================================================================
// CORE UTILITIES
// ============================================================================

/**
 * Persists the current tab configuration to the node's properties.
 * This ensures the state is saved when the workflow is saved.
 * @param {Object} nodeRef - The ComfyUI node instance.
 */
function saveTabsConfig(nodeRef) {
    if (!nodeRef.properties.tabsConfig) {
        console.error("[Neurad] Error: tabsConfig missing!");
        return;
    }
    // Implicitly saved via node properties serialization
}

/**
 * Creates a new custom tab.
 * @param {Object} nodeRef - The node instance.
 * @param {string} name - The display name for the new tab.
 * @returns {Object} The newly created tab object.
 */
function createNewTab(nodeRef, name = "New Tab") {
    const newId = "tab_" + Date.now();
    const newTab = { id: newId, name: name, locked: false, type: "custom", loras: [] };
    nodeRef.properties.tabsConfig.tabs.push(newTab);
    saveTabsConfig(nodeRef);
    return newTab;
}

/**
 * Removes a tab by ID.
 * Prevents deletion of the locked "Library" tab.
 * Switches active focus to "library" if the deleted tab was active.
 * @returns {boolean} True if successful, false otherwise.
 */
function closeTab(nodeRef, tabId) {
    const config = nodeRef.properties.tabsConfig;
    const tabIndex = config.tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return false;
    
    const tab = config.tabs[tabIndex];
    if (tab.locked) { alert("Cannot delete the 'Library' tab."); return false; }
    
    config.tabs.splice(tabIndex, 1);
    if (config.activeTabId === tabId) config.activeTabId = "library";
    
    saveTabsConfig(nodeRef);
    return true;
}

/**
 * Adds a LoRA path to a specific tab's list.
 * Prevents duplicates and modification of locked tabs.
 * @returns {boolean} True if added, false otherwise.
 */
function addLoraToTab(nodeRef, tabId, loraPath) {
    const config = nodeRef.properties.tabsConfig;
    const tab = config.tabs.find(t => t.id === tabId);
    if (!tab || tab.locked) return false;
    if (tab.loras.includes(loraPath)) return false;
    
    tab.loras.push(loraPath);
    saveTabsConfig(nodeRef);
    return true;
}

/**
 * Removes a LoRA path from a specific tab's list.
 * @returns {boolean} True if removed, false otherwise.
 */
function removeLoraFromTab(nodeRef, tabId, loraPath) {
    const config = nodeRef.properties.tabsConfig;
    const tab = config.tabs.find(t => t.id === tabId);
    if (!tab || tab.locked) return false;
    
    const index = tab.loras.indexOf(loraPath);
    if (index > -1) { 
        tab.loras.splice(index, 1); 
        saveTabsConfig(nodeRef); 
        return true; 
    }
    return false;
}

/**
 * Filters the full LoRA catalog based on the active tab and search criteria.
 * 
 * Logic:
 * 1. Determines the base list (Full catalog for "Library"/dynamic tabs, or specific list for custom tabs).
 * 2. If "no_tab" filter is active: Filters baseList to keep ONLY LoRAs not present in any custom tab.
 * 3. Applies Text Filters (Include/Exclude queries).
 * 4. Applies State Filters (On/Off/Has Meta/No Meta).
 * 
 * @param {Array} catalog - The full list of LoRA objects.
 * @param {Object} nodeRef - The node instance.
 * @param {string} tabId - The ID of the active tab.
 * @returns {Array} The filtered list of LoRA objects.
 */
function getLorasForTab(catalog, nodeRef, tabId) {
    if (!catalog) return [];
    const config = nodeRef.properties.tabsConfig;
    const searchConfig = nodeRef.properties.searchConfig;
    
    if (!config || !searchConfig) return [];
    if (!searchConfig.filters || !Array.isArray(searchConfig.filters)) {
        searchConfig.filters = [];
    }

    const tab = config.tabs.find(t => t.id === tabId);
    if (!tab) return [];

    // Determine base list source
    let baseList = [];
    
    if (tab.type === "dynamic" || tab.id === "library") {
        baseList = catalog;
    } else {
        for (const loraPath of tab.loras) {
            const loraObj = catalog.find(l => l.relative_path === loraPath);
            if (loraObj) baseList.push(loraObj);
        }
    }

    // --- NEW LOGIC: "NO_TAB" FILTER ---
    // If the "no_tab" filter is active, filter baseList to keep ONLY LoRAs 
    // that do NOT belong to any custom (non-locked) tab.
    const isNoTabFilterActive = searchConfig.filters.includes("no_tab");
    
    if (isNoTabFilterActive) {
        baseList = baseList.filter(lora => {
            const loraPath = lora.relative_path;
            // Check if this LoRA exists in ANY custom tab
            const isInCustomTab = config.tabs.some(t => {
                return !t.locked && t.type === "custom" && t.loras.includes(loraPath);
            });
            // Keep only if it is NOT in a custom tab
            return !isInCustomTab;
        });
    }
    // ----------------------------------

    // Process Search Queries
    let query = searchConfig.query.trim().toLowerCase();
    let excludeQuery = (searchConfig.excludeQuery || "").trim().toLowerCase();
    
    // Auto-filter NSFW: If "nsfw" is not in the positive query, add it to exclusions
    const isNsfwRequested = query.includes("nsfw");
    if (!isNsfwRequested) {
        if (excludeQuery === "") {
            excludeQuery = "nsfw";
        } else {
            const excludeWords = excludeQuery.split(/\s+/).filter(w => w);
            if (!excludeWords.includes("nsfw")) {
                excludeQuery += " nsfw";
            }
        }
    }
    
    const activeFilters = searchConfig.filters; 
    if (!searchConfig.filters || !Array.isArray(searchConfig.filters)) {
        searchConfig.filters = [];
    }

    // Check if there are other filters besides "no_tab"
    const otherFilters = activeFilters.filter(f => f !== "no_tab");
    
    // Return early if no other filters are active (Text, On/Off, Meta)
    // Note: The "no_tab" filter has already been applied to baseList above.
    if (!query && !excludeQuery && otherFilters.length === 0) return baseList;

    return baseList.filter(lora => {
        // 1. Check Cache for metadata status
        const loraKey = lora.relative_path;
        const cachedMeta = (typeof LocalCache !== 'undefined') ? LocalCache.get(loraKey) : null;
        
        // 2. Determine real 'has_meta' status (Server OR Cache)
        let realHasMeta = false;
        if (lora.has_meta && lora.meta && Object.keys(lora.meta).length > 0) {
            realHasMeta = true;
        } else if (cachedMeta) {
            realHasMeta = true;
        }

        // Determine best display name (Cache > Meta > Default)
        let bestName = lora.display_name || "";
        if (lora.has_meta && lora.meta && lora.meta.name) bestName = lora.meta.name;
        if (cachedMeta && cachedMeta.name) bestName = cachedMeta.name;
        
        // Filter 1: Text Match (Include)
        if (query) {
            const words = query.split(/\s+/);
            const searchableText = (bestName + " " + (lora.relative_path || "") + " " + (lora.subfolder || "")).toLowerCase();
            const textMatch = words.every(word => searchableText.includes(word));
            if (!textMatch) return false;
        }

        // Filter 2: Text Match (Exclude)
        if (excludeQuery) {
            const excludeWords = excludeQuery.split(/\s+/);
            const searchableText = (bestName + " " + (lora.relative_path || "") + " " + (lora.subfolder || "")).toLowerCase();
            // If any excluded word is found, reject the item
            const excludeMatch = !excludeWords.some(word => word && searchableText.includes(word));
            if (!excludeMatch) return false;
        }

        // Filter 3: State Filters (On/Off/Meta)
        for (let i = 0; i < activeFilters.length; i++) {
            const filter = activeFilters[i];
            
            // Skip "no_tab" here as it was already handled above
            if (filter === "no_tab") continue; 

            const currentMap = nodeRef.properties.activeLorasMap || {};
            const isActive = (currentMap[loraKey] || {}).on || false;

            if (filter === "on" && !isActive) return false;
            if (filter === "off" && isActive) return false;
            
            // Use the computed 'realHasMeta' status for filtering
            if (filter === "has_meta" && !realHasMeta) return false;
            if (filter === "no_meta" && realHasMeta) return false;
        }

        return true;
    });
}

// ============================================================================
// UI RENDERING: SEARCH BAR
// ============================================================================
/**
 * Renders the search bar component, including:
 * 1. Positive search input (Include terms).
 * 2. Negative search input (Exclude terms).
 * 3. Dynamic filter buttons (On, Off, Has Meta, No Meta).
 * 
 * Features:
 * - Auto-clears buttons visibility based on input state.
 * - Handles mutual exclusivity for toggle filters (On vs Off, Has Meta vs No Meta).
 * - Applies visual styling based on active/inactive states.
 * - Auto-focuses the last active input field upon render.
 * 
 * @param {Object} nodeRef - The node instance.
 * @param {HTMLElement} container - The parent DOM element to append the search bar to.
 * @param {Array} fullCatalog - The full LoRA catalog (used for context).
 * @param {Function} onSearchChange - Callback triggered when search criteria change.
 */
function renderSearchBar(nodeRef, container, fullCatalog, onSearchChange) {
    const config = nodeRef.properties.searchConfig;
    if (!config) return;

    // Ensure filters array exists
    if (!config.filters || !Array.isArray(config.filters)) {
        config.filters = [];
    }

    const searchBar = document.createElement("div");
    searchBar.classList.add('neurad-search-bar');
    searchBar.style.cssText = `display:flex; flex-direction:column; gap:8px; padding: 10px; padding-top: 0px; background:${CONFIG.COLORS.bg_panel}; border-bottom:1px solid ${CONFIG.COLORS.separator_header}; flex-shrink:0;`;

    // --- ROW 1: Positive Search Input ---
    const row1 = document.createElement("div");
    row1.style.cssText = "display:flex; align-items:center; gap:8px;";
    
    const inputPos = document.createElement("input");
    inputPos.type = "text"; 
    inputPos.value = config.query;
    inputPos.placeholder = "Include (name, file, folder)...";
    inputPos.style.cssText = `flex:1; padding:6px 10px; background:${CONFIG.COLORS.bg_dark}; border:1px solid ${CONFIG.COLORS.border_default}; border-radius:8px; color:${CONFIG.COLORS.text_main}; font-size:13px; outline:none;`;
    
    // Update config on input
    inputPos.oninput = function() { 
        config.query = inputPos.value; 
        config.lastActiveField = "positive"; 
        if (onSearchChange) onSearchChange(); 
    };
    
    // Clear button for Positive Input
    const clearBtnPos = document.createElement("div");
    const textSpanPos = document.createElement("span");
    textSpanPos.innerText = "✕";
    clearBtnPos.appendChild(textSpanPos);

    // Button styling (Centered square)
    const btnStylePos = `
        width: 29px; height: 29px; min-width: 29px;
        background: transparent; cursor: pointer;
        display: flex; justify-content: center; align-items: center;
        border-radius: 4px; padding: 0;
    `;
    // Text styling (Slight vertical offset for visual alignment)
    const textStylePos = `
        font-size: 16px; color: ${CONFIG.COLORS.text_main};
        display: flex; justify-content: center; align-items: center;
        transform: translateY(-1px); 
    `;

    clearBtnPos.style.cssText = btnStylePos;
    textSpanPos.style.cssText = textStylePos;
    clearBtnPos.style.display = config.query ? "flex" : "none";

    clearBtnPos.onmouseover = function() { this.style.background = CONFIG.COLORS.bg_close_hover; };
    clearBtnPos.onmouseout = function() { this.style.background = "transparent"; };
    clearBtnPos.onclick = function() { 
        config.query = ""; inputPos.value = ""; 
        clearBtnPos.style.display = "none"; 
        config.lastActiveField = "positive"; 
        if (onSearchChange) onSearchChange(); 
    };
    
    row1.appendChild(inputPos); 
    row1.appendChild(clearBtnPos);

    // --- ROW 2: Negative Search + Filters ---
    const row2 = document.createElement("div");
    row2.style.cssText = "display:flex; align-items:center; gap:8px; flex-wrap: wrap;";

    // Negative Input
    const inputNeg = document.createElement("input");
    inputNeg.type = "text"; 
    inputNeg.value = config.excludeQuery || "";
    inputNeg.placeholder = "Exclude...";
    inputNeg.style.cssText = `flex:1; padding:6px 10px; background:${CONFIG.COLORS.bg_dark}; border:1px solid ${CONFIG.COLORS.border_negative}; border-radius:8px; color:${CONFIG.COLORS.text_negative}; font-size:13px; outline:none;`;
    inputNeg.oninput = function() { 
        config.excludeQuery = inputNeg.value; 
        config.lastActiveField = "negative"; 
        if (onSearchChange) onSearchChange(); 
    };

    // Clear button for Negative Input
    const clearBtnNeg = document.createElement("div");
    const textSpanNeg = document.createElement("span");
    textSpanNeg.innerText = "✕";
    clearBtnNeg.appendChild(textSpanNeg);

    const btnStyleNeg = `
        width: 29px; height: 29px; min-width: 29px;
        background: transparent; cursor: pointer;
        display: flex; justify-content: center; align-items: center;
        border-radius: 4px; padding: 0;
    `;
    const textStyleNeg = `
        font-size: 16px; color: ${CONFIG.COLORS.text_main};
        display: flex; justify-content: center; align-items: center;
        transform: translateY(-1px); 
    `;

    clearBtnNeg.style.cssText = btnStyleNeg;
    textSpanNeg.style.cssText = textStyleNeg;
    clearBtnNeg.style.display = config.excludeQuery ? "flex" : "none";

    clearBtnNeg.onmouseover = function() { this.style.background = CONFIG.COLORS.bg_close_hover; };
    clearBtnNeg.onmouseout = function() { this.style.background = "transparent"; };
    clearBtnNeg.onclick = function() { 
        config.excludeQuery = ""; inputNeg.value = ""; 
        clearBtnNeg.style.display = "none"; 
        config.lastActiveField = "negative"; 
        if (onSearchChange) onSearchChange(); 
    };

    row2.appendChild(inputNeg);
    row2.appendChild(clearBtnNeg);

    /**
     * Helper to create filter buttons with mutual exclusivity logic.
     * @param {string} label - Text label (if no icon).
     * @param {string} icon - Icon character (if applicable).
     * @param {string} filterValue - The filter ID (e.g., "on", "has_meta").
     */
    const createFilterBtn = function(label, icon, filterValue) {
        const btn = document.createElement("div");
        const isActive = config.filters.indexOf(filterValue) > -1;
        
        // Determine colors based on active state
        let borderColor = CONFIG.COLORS.border_default;
        let textColor = CONFIG.COLORS.text_main;
        let iconFilter = "none";

        if (isActive) {
            borderColor = CONFIG.COLORS.border_active;
        }
        if (filterValue === "no_meta"){
            iconFilter = "grayscale(100%)";
        }

        // Base Button Style
        btn.style.cssText = `
            width: 29px; height: 29px; min-width: 29px;
            background: transparent; border: 1px solid ${borderColor};
            color: ${textColor}; border-radius: 4px;
            cursor: pointer; display: flex;
            justify-content: center; align-items: center;
            user-select: none; padding: 0; margin-right: 4px;
        `;

        // Content (Icon or Text)
        const contentSpan = document.createElement("span");
        contentSpan.innerText = icon ? icon : label;
        contentSpan.style.cssText = `
            font-weight: bold; font-size: ${icon ? "14px" : "11px"};
            display: flex; justify-content: center; align-items: center;
            filter: ${iconFilter}; line-height: 1;
        `;
        btn.appendChild(contentSpan);

        // Click Handler with Mutual Exclusivity Logic
        btn.onclick = function(e) {
            e.stopPropagation();
            let newFilters = [...config.filters];
            const idx = newFilters.indexOf(filterValue);

            if (filterValue === "on") {
                if (idx === -1) {
                    newFilters = newFilters.filter(f => f !== "off");
                    newFilters.push("on");
                } else {
                    newFilters.splice(idx, 1);
                }
            } else if (filterValue === "off") {
                if (idx === -1) {
                    newFilters = newFilters.filter(f => f !== "on");
                    newFilters.push("off");
                } else {
                    newFilters.splice(idx, 1);
                }
            } else if (filterValue === "has_meta") {
                if (idx === -1) {
                    newFilters = newFilters.filter(f => f !== "no_meta");
                    newFilters.push("has_meta");
                } else {
                    newFilters.splice(idx, 1);
                }
            } else if (filterValue === "no_meta") {
                if (idx === -1) {
                    newFilters = newFilters.filter(f => f !== "has_meta");
                    newFilters.push("no_meta");
                } else {
                    newFilters.splice(idx, 1);
                }
            } else {
                // Standard toggle
                if (idx > -1) newFilters.splice(idx, 1);
                else newFilters.push(filterValue);
            }

            config.filters = newFilters;
            config.lastActiveField = "positive";
            if (onSearchChange) onSearchChange();
        };

        // Hover Effects
        btn.onmouseover = function() {
            this.style.background = CONFIG.COLORS.bg_toggle_faded;
            this.style.cursor = "pointer";
        };
        btn.onmouseout = function() {
            this.style.background = "transparent";
            this.style.borderColor = isActive ? CONFIG.COLORS.border_active : CONFIG.COLORS.border_default;
        };

        return btn;
    };

    // Create and append filter buttons
    row2.appendChild(createFilterBtn("ON", null, "on"));
    row2.appendChild(createFilterBtn("OFF", null, "off"));
    row2.appendChild(createFilterBtn(null, "ℹ️", "has_meta"));
    row2.appendChild(createFilterBtn(null, "ℹ️", "no_meta"));
	
	// --- NEW BUTTON: Unassigned LoRAs Filter ---
    // Uses "∅" icon to represent "not in any tab"
    row2.appendChild(createFilterBtn(null, "➖", "no_tab"));
    // -------------------------------------------

    searchBar.appendChild(row1);
    searchBar.appendChild(row2);
    container.appendChild(searchBar);

    // Auto-focus logic: Restore cursor to the last active input field
    setTimeout(function() {
        const activeField = config.lastActiveField || "positive";
        const targetInput = activeField === "negative" ? inputNeg : inputPos;
        if(targetInput) {
            targetInput.focus();
            const val = targetInput.value; 
            targetInput.value = ''; 
            targetInput.value = val; // Trick to ensure cursor is at end
        }
    }, 10);
}

// --- HELPER: Compute LoRA counts for a specific tab ---
/**
 * Calculates the number of active ("On") and inactive ("Off") LoRAs within a specific tab.
 * Used to display the [On/Off] badges on tab buttons.
 * 
 * @param {Object} tab - The tab object.
 * @param {Array} currentCatalog - The full list of LoRAs.
 * @param {Object} activeMap - The map of currently active LoRA states.
 * @returns {Object} { onCount: number, offCount: number }
 */
function computeTabCounts(tab, currentCatalog, activeMap) {
    let onCount = 0, offCount = 0;
    
    // Determine which LoRAs belong to this tab
    const lorasInThisTab = (tab.id === "library" || tab.type === "dynamic")
        ? currentCatalog
        : currentCatalog.filter(l => l && l.relative_path && tab.loras.includes(l.relative_path));
    
    lorasInThisTab.forEach(lora => {
        if (!lora || !lora.relative_path) return;
        const state = activeMap[lora.relative_path];
        if (state && state.on) onCount++;
        else offCount++;
    });
    return { onCount, offCount };
}

// --- HELPER: Create HTML fragment for a count badge ---
/**
 * Generates a DOM fragment for a single count badge (e.g., "[5]").
 * Styles the number bold if count > 0.
 * 
 * @param {number} count - The number to display.
 * @param {string} color - The CSS color for the text.
 * @returns {DocumentFragment}
 */
function createCounterPart(count, color) {
    const frag = document.createDocumentFragment();
    
    const open = document.createElement("span"); 
    open.innerText = "["; 
    open.style.cssText = `font-size:13px; color:${color}; line-height:1; vertical-align:top; margin-left:4px;`;
    
    const num = document.createElement("span"); 
    num.innerText = count; 
    num.style.cssText = `font-size:10px; color:${color}; font-weight:${count>0?'bold':'normal'}; vertical-align:top; margin-top:2px;`;
    
    const close = document.createElement("span"); 
    close.innerText = "]"; 
    close.style.cssText = `font-size:13px; color:${color}; line-height:1; vertical-align:top;`;
    
    frag.append(open, num, close); 
    return frag;
}

// --- HELPER: Update a single tab counter in place ---
/**
 * Updates the counter badge of a specific tab button without re-rendering the entire tab bar.
 * Optimizes performance during drag-and-drop operations or state changes.
 * 
 * @param {Object} nodeRef - The node instance.
 * @param {HTMLElement} tabBtn - The specific tab button DOM element.
 * @param {Object} tab - The tab data object.
 * @param {Array} currentCatalog - The full LoRA catalog.
 */
function updateTabCounterInPlace(nodeRef, tabBtn, tab, currentCatalog) {
    const counterSpan = tabBtn.querySelector('.neurad-tab-counter');
    if (!counterSpan) return;
    
    const activeMap = nodeRef.properties.activeLorasMap || {};
    const { onCount, offCount } = computeTabCounts(tab, currentCatalog, activeMap);
    
    counterSpan.innerHTML = '';
    counterSpan.appendChild(createCounterPart(onCount, CONFIG.COLORS.bg_card_active));
    counterSpan.appendChild(createCounterPart(offCount, CONFIG.COLORS.text_faded));
}

// ============================================================================
// UI RENDERING: TABS BAR
// ============================================================================
/**
 * Renders the horizontal tab bar.
 * Features:
 * - Displays tabs with active/inactive states and LoRA count badges.
 * - Supports renaming (double-click), deletion (x button), and creation (+ button).
 * - Implements Drag & Drop for reordering tabs.
 * - Implements Drop Zone logic for accepting LoRA cards from other tabs.
 * - Maintains scroll position during refreshes (loaded from node properties).
 * 
 * @param {Object} nodeRef - The node instance.
 * @param {HTMLElement} container - Parent DOM element.
 * @param {Array} currentCatalog - The full LoRA catalog.
 * @param {Function} onTabChange - Callback when active tab changes.
 * @param {Function} refreshCallback - Callback to refresh the UI.
 */
function renderTabsBar(nodeRef, container, currentCatalog, onTabChange, refreshCallback) {

    const config = nodeRef.properties.tabsConfig;
    if (!config || !currentCatalog) {
        console.warn("[Neurad] renderTabsBar aborted: Missing config or catalog.");
        return;
    }

    // Clean up existing bar
    const existingBar = container.querySelector('.neurad-tab-bar');
    if (existingBar) existingBar.remove();

    const tabBar = document.createElement("div");
    tabBar.classList.add('neurad-tab-bar');
    tabBar.style.cssText = `display:flex; align-items:flex-start; gap:2px; padding:0px 10px 0 10px; background:${CONFIG.COLORS.bg_dark}; border-bottom:1px solid ${CONFIG.COLORS.separator_header}; flex-shrink:0; overflow-x:auto; white-space:nowrap; scrollbar-width:thin; scrollbar-color:${CONFIG.COLORS.bg_button} ${CONFIG.COLORS.bg_dark}; position: relative;`;
    
    // RESTORE SCROLL POSITION FROM NODE PROPERTIES
    // (unless a tab was just created and needs the bar scrolled fully into view)
    requestAnimationFrame(() => {
        if (nodeRef._scrollTabsToEnd) {
            nodeRef._scrollTabsToEnd = false;
            if (tabBar.scrollWidth > tabBar.clientWidth) {
                tabBar.scrollLeft = tabBar.scrollWidth - tabBar.clientWidth;
                config.tabScrollX = tabBar.scrollLeft;
                saveTabsConfig(nodeRef);
                return;
            }
        }
        tabBar.scrollLeft = (config.tabScrollX || 0);
    });

    // SAVE SCROLL POSITION ON CHANGE
    tabBar.addEventListener('scroll', () => {
        config.tabScrollX = tabBar.scrollLeft;
        saveTabsConfig(nodeRef);
    });

    // MOUSE WHEEL: convert vertical wheel scroll into horizontal tab bar scroll
    // (wheel up -> scroll left, wheel down -> scroll right)
    tabBar.addEventListener('wheel', (e) => {
        if (e.deltaY === 0) return;
        e.preventDefault();
        tabBar.scrollLeft += e.deltaY;
    }, { passive: false });

    // Ensure at least the Library tab exists
    if (!config.tabs || config.tabs.length === 0) {
        config.tabs = [{ id: "library", name: "Library", locked: true, type: "dynamic", loras: [] }];
        config.activeTabId = "library";
    }

    config.tabs.forEach((tab, tabIndex) => {
        const isActive = tab.id === config.activeTabId;
        const tabBtn = document.createElement("div");
        tabBtn.innerText = tab.name;
        tabBtn.classList.add('neurad-tab');
        if (isActive) tabBtn.classList.add('active');
        tabBtn.style.position = "relative"; 

        // --- COUNTER BADGES ---
        const activeMap = nodeRef.properties.activeLorasMap || {};
        const { onCount, offCount } = computeTabCounts(tab, currentCatalog, activeMap);

        const counterSpan = document.createElement("span");
        counterSpan.classList.add('neurad-tab-counter');
        counterSpan.style.cssText = "opacity:1; display:inline-flex; gap:2px; padding: 0px 23px 3px 0px; margin-left:-2px;";
        counterSpan.appendChild(createCounterPart(onCount, CONFIG.COLORS.bg_card_active));
        counterSpan.appendChild(createCounterPart(offCount, CONFIG.COLORS.text_faded));
        tabBtn.appendChild(counterSpan);

        // --- EVENTS: Rename & Activate ---
        tabBtn.ondblclick = (e) => { 
            e.stopPropagation(); 
            const newName = prompt("New tab name:", tab.name); 
            if (newName && newName.trim() !== "") { 
                tab.name = newName.trim(); 
                saveTabsConfig(nodeRef); 
                if (onTabChange) onTabChange(); 
            } 
        };
        
        tabBtn.onclick = () => { 
            if (config.activeTabId !== tab.id) { 
                config.activeTabId = tab.id; 
                saveTabsConfig(nodeRef); 
                if (onTabChange) onTabChange(); 
            } 
        };

        // --- CLOSE BUTTON (Only for non-locked tabs) ---
        if (!tab.locked) {
            const closeBtn = document.createElement("span");
            closeBtn.innerText = "✕"; 
            closeBtn.style.cssText = `
                font-size: 14px; position: absolute; right: 0px; top: 0; bottom: 0;
                width: 28px; background: transparent; border: none;
                border-radius: 4px; cursor: pointer; padding: 0px 0px 1px 0px;
                margin: 0; display: flex; align-items: center;
                justify-content: center; z-index: 10;
            `;
            
            // Dynamic color logic: Light gray if active or hovered, dark gray otherwise
            const updateCloseBtnStyle = () => {
                const isTabActive = (tab.id === config.activeTabId);
                const isBtnHovered = closeBtn.matches(':hover');
                if (isBtnHovered) {
                    closeBtn.style.color = CONFIG.COLORS.text_node_title; // Light
                } else {
                    closeBtn.style.color = CONFIG.COLORS.text_faded; // Dark
                }
            };

            closeBtn.onmouseenter = (e) => { 
                e.stopPropagation(); 
                closeBtn.style.backgroundColor = CONFIG.COLORS.bg_close_hover;
                updateCloseBtnStyle(); 
            };
            closeBtn.onmouseleave = (e) => { 
                e.stopPropagation(); 
                closeBtn.style.backgroundColor = "transparent";
                updateCloseBtnStyle(); 
            };
            tabBtn.onmouseenter = (e) => { updateCloseBtnStyle(); };
            tabBtn.onmouseleave = (e) => { updateCloseBtnStyle(); };
            
            const originalOnClick = tabBtn.onclick;
            tabBtn.onclick = (e) => {
                if (originalOnClick) originalOnClick(e);
                setTimeout(updateCloseBtnStyle, 10);
            };
            updateCloseBtnStyle(); // Init
            
            closeBtn.onclick = (e) => { 
                e.stopPropagation(); 
                if (confirm(`Delete tab "${tab.name}"?`)) { 
                    closeTab(nodeRef, tab.id); 
                    if (onTabChange) onTabChange(); 
                } 
            };
            tabBtn.appendChild(closeBtn);
        }

        // --- DRAG & DROP LOGIC (Unified for Tabs and Cards) ---
        if (!tab.locked) {
            tabBtn.draggable = true;
            let currentMarkerSide = null;

            // Helper: Reset all visual drag indicators on a button
            const resetVisuals = (btn) => {
                if (!btn) return;
                // Reset Tab Drag styles
                btn.style.borderLeft = ""; btn.style.borderRight = "";
                btn.style.marginLeft = ""; btn.style.marginRight = "";
                btn.style.boxSizing = "";
                // Reset Card Drop styles
                btn.style.background = "";
                // Reset Opacity
                if (btn.style.opacity === "0.6") {
                    btn.style.opacity = (btn.classList.contains('active')) ? "1" : "";
                }
            };

            // 1. DRAG START (Tab Reorder)
            tabBtn.ondragstart = (e) => { 
                if (e.target !== tabBtn) { e.preventDefault(); return; }
                e.stopPropagation(); 				
                if (typeof neuradDragState !== 'undefined') neuradDragState = "tab-reorder";
                
                e.dataTransfer.setData("application/x-neurad-tab-reorder", tabIndex.toString());
                e.dataTransfer.setData("application/json", JSON.stringify({ 
                    type: "tab_reorder", dragType: "tab-reorder", index: tabIndex, tabId: tab.id 
                })); 
                e.dataTransfer.effectAllowed = "move"; 
                tabBtn.style.opacity = "0.4"; 
            };

            // 2. DRAG END (Cleanup)
            tabBtn.ondragend = () => { 
                if (typeof neuradDragState !== 'undefined') neuradDragState = null;
                resetVisuals(tabBtn);
                currentMarkerSide = null;
            };

            // 3. DRAG ENTER (Global Cleaner & Preview)
            tabBtn.ondragenter = (e) => {
                e.preventDefault(); e.stopPropagation();
                const types = e.dataTransfer.types;
                const isDragTab = types.includes("application/x-neurad-tab-reorder");
                const isDragCard = types.includes("application/json") && !isDragTab;

                if (isDragTab || isDragCard) {
                    // Clear visuals on ALL other tabs
                    const allTabs = tabBar.querySelectorAll('.neurad-tab');
                    allTabs.forEach(t => { if (t !== tabBtn) resetVisuals(t); });
                    
                    // Set preview style based on drag type
                    if (isDragTab) {
                        tabBtn.style.opacity = "0.6"; tabBtn.style.background = "";
                    } else if (isDragCard) {
                        tabBtn.style.background = CONFIG.COLORS.bg_card_active_hover;
                        tabBtn.style.opacity = "";
                    }
                }
            };

            // 4. DRAG OVER (Position Marker for Tabs, Highlight for Cards)
            tabBtn.ondragover = (e) => { 
                e.preventDefault(); e.stopPropagation(); 
                const types = e.dataTransfer.types;
                const isDragTab = types.includes("application/x-neurad-tab-reorder");
                const isDragCard = types.includes("application/json") && !isDragTab;

                if (isDragCard) {
                    // Card Drop: Ensure background is set, no borders
                    tabBtn.style.borderLeft = ""; tabBtn.style.borderRight = "";
                    tabBtn.style.marginLeft = ""; tabBtn.style.marginRight = "";
                    tabBtn.style.background = CONFIG.COLORS.bg_card_active_hover; 
                }
                else if (isDragTab) {
                    // Tab Reorder: Show left/right insertion marker
                    const rect = tabBtn.getBoundingClientRect(); 
                    const midX = rect.left + rect.width / 2;
                    const newSide = (e.clientX < midX) ? 'left' : 'right'; 
                    
                    if (currentMarkerSide !== newSide) {
                        currentMarkerSide = newSide;
                        // Reset
                        tabBtn.style.borderLeft = ""; tabBtn.style.borderRight = "";
                        tabBtn.style.marginLeft = ""; tabBtn.style.marginRight = "";
                        tabBtn.style.boxSizing = "content-box";

                        if (newSide === 'left') {
                            tabBtn.style.borderLeft = "3px solid #4da6ff";
                            tabBtn.style.marginLeft = "-3px";
                        } else {
                            tabBtn.style.borderRight = "3px solid #4da6ff";
                            tabBtn.style.marginRight = "-3px";
                        }
                    }
                } 
                else { resetVisuals(tabBtn); }
            };

            // 5. DRAG LEAVE (Self Cleanup)
            tabBtn.ondragleave = (e) => { 
                if (e.target === tabBtn) {
                    resetVisuals(tabBtn);
                    currentMarkerSide = null;
                }
            };

            // 6. DROP (Handle Reorder or Card Add)
            tabBtn.ondrop = (e) => {
                e.preventDefault(); e.stopPropagation();  
                resetVisuals(tabBtn); currentMarkerSide = null;
                const types = e.dataTransfer.types;
                
                // Case A: Tab Reorder
                if (types.includes("application/x-neurad-tab-reorder")) {
                    try {
                        const data = e.dataTransfer.getData("application/json");
                        if (!data) return;
                        const payload = JSON.parse(data);
                        
                        if (payload.dragType === "tab-reorder" && typeof payload.index === 'number') {
                            const sourceIndex = payload.index;
                            let targetIndex = tabIndex;
                            
                            const rect = tabBtn.getBoundingClientRect();
                            if (e.clientX >= rect.left + rect.width / 2) { targetIndex = targetIndex + 1; }
                            
                            if (sourceIndex >= 0 && sourceIndex < config.tabs.length) {
                                const movedTab = config.tabs.splice(sourceIndex, 1)[0];
                                if (sourceIndex < targetIndex) targetIndex = targetIndex - 1;
                                targetIndex = Math.max(0, Math.min(targetIndex, config.tabs.length));
                                config.tabs.splice(targetIndex, 0, movedTab);
                                saveTabsConfig(nodeRef);
                                if (onTabChange) onTabChange();
                            }
                        }
                    } catch (err) { console.error("[Neurad] Tab reorder drop error:", err); }
                } 
                // Case B: Card Drop (Add LoRA to this tab)
                else if (types.includes("application/json")) {
                    try {
                        const data = e.dataTransfer.getData("application/json");
                        if (!data) return;
                        const payload = JSON.parse(data);
                        
                        if (payload.dragType === "lora-card" && payload.loraPath && payload.sourceTabId) {
                            const targetTabId = tab.id;
                            if (payload.sourceTabId !== targetTabId) {
                                const added = addLoraToTab(nodeRef, targetTabId, payload.loraPath);
                                
                                if (added) {
                                    requestAnimationFrame(() => {
                                        // --- OPTIMIZATION: Avoid flicker unless necessary ---
                                        const isNoTabActive = (nodeRef.properties.searchConfig && 
                                                               nodeRef.properties.searchConfig.filters && 
                                                               nodeRef.properties.searchConfig.filters.includes("no_tab"));
                                        
                                        // If 'no_tab' filter is ON: The moved LoRA must disappear from the current view (Library).
                                        // A full refresh is required to re-filter the list.
                                        if (isNoTabActive) {
                                            if (refreshCallback) refreshCallback();
                                        } 
                                        // If 'no_tab' filter is OFF: The LoRA stays visible in Library (or we are in another tab).
                                        // No need to redraw the whole grid. Just update the target tab's counter badge.
                                        else {
                                            updateTabCounterInPlace(nodeRef, tabBtn, tab, currentCatalog);
                                        }
                                        // ----------------------------------------------------
                                    });
                                }
                            }
                        }
                    } catch (err) { console.error("[Neurad] Card drop error:", err); }
                }
            };
        } else {
            tabBtn.draggable = false;
        }

        tabBar.appendChild(tabBtn);
    });

    // --- NEW TAB BUTTON ---
    const newTabBtn = document.createElement("div");
    newTabBtn.innerText = "+";
    newTabBtn.style.cssText = `
        display: flex; justify-content: center; align-items: center;
        height: 28px; width: 28px; font-weight: 100; font-size: 24px;
        line-height: 1; color: ${CONFIG.COLORS.text_main};
        background: transparent; border: none; border-radius: 4px;
        margin-left: 10px; margin-top: 4px; cursor: pointer; flex-shrink: 0;
    `;	
    newTabBtn.onmouseover = function() { this.style.backgroundColor = CONFIG.COLORS.bg_card_active; };
    newTabBtn.onmouseout = function() { this.style.backgroundColor = "transparent"; };
    newTabBtn.onclick = () => { 
        const name = prompt("New tab name:", "New Tab"); 
        if (name) { 
            createNewTab(nodeRef, name); 
            nodeRef._scrollTabsToEnd = true;
            if (onTabChange) onTabChange(); 
        } 
    };
    tabBar.appendChild(newTabBtn);

    container.appendChild(tabBar);
}

/**
 * Returns the URL of the first image in `images` that isn't listed in
 * `hiddenImages`, or null if there are no images or all of them are hidden.
 * Shared by the card grid thumbnail, the edit modal's cover-picker default,
 * and the info modal's cover badge -- so a hidden image is never silently
 * used as a fallback thumbnail anywhere in the UI.
 *
 * @param {Array} images - Array of {url, ...} objects.
 * @param {Array} hiddenImages - Array of hidden image URLs.
 * @returns {string|null}
 */
function getFirstVisibleImageUrl(images, hiddenImages) {
    if (!images || images.length === 0) return null;
    const hiddenSet = new Set(hiddenImages || []);
    const visible = images.find(img => !hiddenSet.has(img.url));
    return visible ? visible.url : null;
}

// ============================================================================
// UI RENDERING: LORA GRID
// ============================================================================
/**
 * Renders the grid of LoRA cards based on the filtered list.
 * 
 * Features:
 * - Virtual-like caching for images (NeuradImageCache).
 * - Dynamic metadata merging (Server Meta + Local Cache).
 * - Interactive controls: Strength slider, Info modal, Remove button.
 * - Drag & Drop: Reordering within grid, moving between tabs.
 * - Scroll lock during drag operations to prevent layout shifts.
 * - Maintains scroll position from node properties.
 * 
 * @param {Object} nodeRef - The node instance.
 * @param {Array} fullCatalog - The full LoRA catalog.
 * @param {HTMLElement} container - Parent DOM element.
 * @param {Function} refreshCallback - Callback to refresh the UI.
 */
function renderLoraGrid(nodeRef, fullCatalog, container, refreshCallback) {
    const currentTabId = nodeRef.properties.tabsConfig.activeTabId;
    const filteredLoras = getLorasForTab(fullCatalog, nodeRef, currentTabId);
    const currentTab = nodeRef.properties.tabsConfig.tabs.find(t => t.id === currentTabId);
    const isLibrary = (currentTabId === "library");

    const gridContainer = document.createElement("div");
    gridContainer.style.cssText = `display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap: 15px; padding:15px; overflow-y:auto; flex:1; grid-auto-rows: ${CONFIG.CARD_HEIGHT}; align-content:start; align-items:start; min-height:200px; transition:background 0.2s;`;
    
    // RESTORE SCROLL POSITION FROM NODE PROPERTIES
    requestAnimationFrame(() => { 
        gridContainer.scrollTop = (nodeRef.properties.tabsConfig.gridScrollY || 0); 
    });

    // SAVE SCROLL POSITION ON CHANGE
    gridContainer.addEventListener('scroll', () => {
        nodeRef.properties.tabsConfig.gridScrollY = gridContainer.scrollTop;
        saveTabsConfig(nodeRef);
    });

    // Scroll Lock Logic: Prevents native scrolling while dragging a card to keep target visible
    let gridScrollLockActive = false;
    let gridScrollLockValue = 0;
    gridContainer.addEventListener("scroll", () => {
        if (gridScrollLockActive) gridContainer.scrollTop = gridScrollLockValue;
    });

    // Empty State
    if (filteredLoras.length === 0) {
        const emptyMsg = document.createElement("div");
        emptyMsg.style.cssText = `grid-column:1/-1; text-align:center; padding:40px; color:${CONFIG.COLORS.text_faded}; font-size:14px; white-space:pre-line;`;
        emptyMsg.innerText = isLibrary ? "No LoRAs found in your folders." : "This tab is empty.\nDrag LoRAs from the Library.";
        gridContainer.appendChild(emptyMsg);
    } else {
        filteredLoras.forEach((lora, index) => {
            const loraKey = lora.relative_path;
            
            // --- 1. DATA & CACHE MERGING ---
            const cachedMeta = (typeof LocalCache !== 'undefined') ? LocalCache.get(loraKey) : null;
            const isEdited = !!cachedMeta;
            
            // Determine if the LoRA has valid info (Server Meta OR Manual Edits)
            let has_info = false;
            if (lora.has_meta && lora.meta && Object.keys(lora.meta).length > 0) {
                has_info = true;
            } else if (cachedMeta) {
                // Check if manual edits exist (URL, Cover, Name, Words, Strength)
                if (cachedMeta.customImageUrl || cachedMeta.coverImage || 
                    (cachedMeta.name && cachedMeta.name !== lora.display_name) || 
                    (cachedMeta.trainedWords && cachedMeta.trainedWords.length > 0) ||
                    (cachedMeta.strengthMin !== null && cachedMeta.strengthMin !== undefined) ||
                    (cachedMeta.strengthMax !== null && cachedMeta.strengthMax !== undefined)) {
                    has_info = true;
                }
            }
            
            // Force 'has_meta' flag if manual info exists (for filtering consistency)
            if (has_info) {
                lora.has_meta = true; 
                if (!lora.meta) lora.meta = {};
                if (cachedMeta) lora.meta = { ...lora.meta, ...cachedMeta };
            }
            
            // --- 2. IMAGE SELECTION PRIORITY ---
            let imageUrl = null;
            if (cachedMeta && cachedMeta.customImageUrl) {
                imageUrl = cachedMeta.customImageUrl; // Priority 1: Custom URL
            } else if (cachedMeta && cachedMeta.coverImage) {
                imageUrl = cachedMeta.coverImage;     // Priority 2: Selected Cover
            } else if (cachedMeta && cachedMeta.images && cachedMeta.images.length > 0) {
                imageUrl = getFirstVisibleImageUrl(cachedMeta.images, cachedMeta.hiddenImages); // Priority 3: Cached First Visible Image
            } else if (lora.has_meta && lora.meta && lora.meta.images && lora.meta.images.length > 0) {
                imageUrl = getFirstVisibleImageUrl(lora.meta.images, lora.meta.hiddenImages);   // Priority 4: Server First Visible Image
            }
            const hasImages = !!imageUrl;

            // --- 3. DISPLAY NAME ---
            let displayName = lora.display_name || "Unknown";
            if (cachedMeta && cachedMeta.name) displayName = cachedMeta.name;
            else if (lora.has_meta && lora.meta && lora.meta.name) displayName = lora.meta.name;
            if (displayName.length > 30) displayName = displayName.substring(0, 27) + "...";

            // --- 4. ACTIVE STATE (ON/OFF) ---
            const currentMap = nodeRef.properties.activeLorasMap || {};
            const storedState = currentMap[loraKey] || { on: false, strength: 1.0 };
            const isOn = storedState.on;

            // --- 5. CARD CREATION ---
            const card = document.createElement("div");
            card.style.cssText = `background:${isOn ? CONFIG.COLORS.bg_card_active : CONFIG.COLORS.bg_card_inactive}; border:1px solid ${isOn ? CONFIG.COLORS.bg_card_active : CONFIG.COLORS.border_default}; border-radius:6px; padding:6px; display:flex; flex-direction:column; align-items:center; cursor:grab; transition:background 0.2s, transform 0.1s; gap:6px; height:${CONFIG.CARD_HEIGHT_PX}; overflow:hidden; position:relative;`;
            card.draggable = true;
            
            card.ondragend = () => {
                neuradDragState = null;
                card.style.opacity = "1";
            };

            // Hover Effects
            card.onmouseenter = function() { 
                const currentState = (nodeRef.properties.activeLorasMap[loraKey] || {}).on || false; 
                this.style.backgroundColor = currentState ? CONFIG.COLORS.bg_card_active_hover : CONFIG.COLORS.bg_card_hover; 
                this.style.transform = "scale(1.03)"; 
                this.style.zIndex = "10"; 
                this.style.boxShadow = "0 4px 15px rgba(0,0,0,0.5)"; 
                if (removeBtn) removeBtn.style.opacity = "1"; 
            };
            card.onmouseleave = function() { 
                const currentState = (nodeRef.properties.activeLorasMap[loraKey] || {}).on || false; 
                this.style.backgroundColor = currentState ? CONFIG.COLORS.bg_card_active : CONFIG.COLORS.bg_card_inactive; 
                this.style.transform = "scale(1)"; 
                this.style.zIndex = "1"; 
                this.style.boxShadow = "none"; 
                if (removeBtn) removeBtn.style.opacity = "0"; 
            };

            // --- 6. IMAGE CONTAINER ---
            const imgContainer = document.createElement("div");
            imgContainer.style.cssText = `width:100%; height:160px; background: transparent; border-radius:4px; overflow:hidden; display:flex; justify-content:center; align-items:center; font-size:30px; color:${CONFIG.COLORS.text_faded}; margin-bottom:4px; position:relative;`;
            
            if (hasImages) {
                // Retrieve from cache or create new
                let img = NeuradImageCache.get(imageUrl);
                if (img) {
                    img = img.cloneNode(true); 
                } else {
                    img = document.createElement("img");
                    img.src = imageUrl;
                    img.onload = () => { NeuradImageCache.set(imageUrl, img); };
                    img.onerror = function() { 
                        this.style.display = "none"; 
                        imgContainer.innerText = "⚠️ Err"; 
                        imgContainer.style.color = CONFIG.COLORS.text_error;
                        imgContainer.style.fontSize = "10px";
                        imgContainer.style.cursor = "pointer";
                        imgContainer.onclick = (e) => { e.stopPropagation(); alert("Invalid image. Edit LoRA to change URL."); };
                    };
                }
                img.style.cssText = "width:100%; height:100%; object-fit:cover;";
                imgContainer.appendChild(img);
                if (imgContainer.innerText === "") imgContainer.style.pointerEvents = "none";
            } else {
                // Placeholder for "Get Info"
                imgContainer.style.background = CONFIG.COLORS.bg_dark;
                imgContainer.style.cursor = "pointer";
                imgContainer.style.flexDirection = "column";
                imgContainer.style.gap = "8px";
                imgContainer.style.pointerEvents = "auto";
                
                const icon = document.createElement("div"); icon.innerText = "📥"; icon.style.fontSize = "32px"; icon.style.color = CONFIG.COLORS.bg_card_active;
                const label = document.createElement("div"); label.innerText = "Get Info"; label.style.fontSize = "11px"; label.style.color = CONFIG.COLORS.text_main; label.style.fontWeight = "bold";
                imgContainer.appendChild(icon); imgContainer.appendChild(label);
                imgContainer.onmouseenter = function() { this.style.background = CONFIG.COLORS.bg_tab_hover; };
                imgContainer.onmouseleave = function() { this.style.background = CONFIG.COLORS.bg_dark; };
                imgContainer.onclick = (e) => { e.stopPropagation(); e.preventDefault(); triggerFetchSingleInfo(nodeRef, lora, imgContainer, refreshCallback); };
            }

            // --- 7. NAME LABEL ---
            const nameSpan = document.createElement("div");
            nameSpan.innerText = displayName;
            nameSpan.style.cssText = `font-size:11px; text-align:center; width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:${CONFIG.COLORS.text_main}; pointer-events:none; margin-bottom:4px;`;
            nameSpan.title = (cachedMeta && cachedMeta.name) ? cachedMeta.name : ((lora.meta && lora.meta.name) ? lora.meta.name : lora.display_name);

            // --- 8. CONTROLS (Strength + Info) ---
            const controlsRow = document.createElement("div");
            controlsRow.style.cssText = `display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; width:100%; position: relative; overflow: visible;`;

            const topRow = document.createElement("div");
            topRow.style.cssText = "display:flex; align-items:center; justify-content:center; gap:6px; width:100%;";

            // Strength Widget
            const strengthWidget = document.createElement("div");
            strengthWidget.style.cssText = `display: flex; align-items: center; justify-content: space-between; width: 70px; height: 18px; background: ${CONFIG.COLORS.bg_dark}; border: 1px solid ${CONFIG.COLORS.border_default}; border-radius: 20px; padding: 0 2px; box-sizing: border-box; cursor: text; user-select: none; font-family: sans-serif;`;
            
            const btnMinus = document.createElement("div"); btnMinus.innerText = "◄"; btnMinus.style.cssText = `color: ${CONFIG.COLORS.bg_button}; font-size: 12px; font-weight: bold; cursor: pointer; user-select: none; flex-shrink: 0; line-height: 1; padding: 0 0px; transition: color 0.2s;`;
            btnMinus.onmouseover = () => { btnMinus.style.color = CONFIG.COLORS.bg_button_hover; }; btnMinus.onmouseout = () => { btnMinus.style.color = CONFIG.COLORS.bg_button; };
            
            const valueDisplay = document.createElement("div"); valueDisplay.innerText = storedState.strength.toFixed(2); valueDisplay.style.cssText = `flex: 1; text-align: center; font-size: 11px; color: ${CONFIG.COLORS.text_main}; cursor: text; user-select: text; padding: 0 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 24px;`;
            valueDisplay.contentEditable = "true"; 
            valueDisplay.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") valueDisplay.blur(); };
            valueDisplay.oninput = (e) => e.stopPropagation();
            valueDisplay.onblur = () => { let val = parseFloat(valueDisplay.innerText); if (isNaN(val)) val = 0; val = Math.max(-99.95, Math.min(99.95, val)); val = Math.round(val * 20) / 20; valueDisplay.innerText = val.toFixed(2); updateStrength(val); };
            
            const btnPlus = document.createElement("div"); btnPlus.innerText = "►"; btnPlus.style.cssText = `color: ${CONFIG.COLORS.bg_button}; font-size: 12px; font-weight: bold; cursor: pointer; user-select: none; flex-shrink: 0; line-height: 1; padding: 0 0px; transition: color 0.2s;`;
            btnPlus.onmouseover = () => { btnPlus.style.color = CONFIG.COLORS.bg_button_hover; }; btnPlus.onmouseout = () => { btnPlus.style.color = CONFIG.COLORS.bg_button; };
            
            const updateStrength = (newVal) => { nodeRef.properties.activeLorasMap[loraKey] = { on: isOn, strength: newVal, name: lora.name, subfolder: lora.subfolder }; syncLoraDataToWidget(nodeRef); };
            const step = 0.05;
            btnMinus.onclick = (e) => { e.stopPropagation(); e.preventDefault(); let current = parseFloat(valueDisplay.innerText) || 0; let newVal = Math.round((current - step) * 20) / 20; newVal = Math.max(-99.95, Math.min(99.95, newVal)); valueDisplay.innerText = newVal.toFixed(2); updateStrength(newVal); };
            btnPlus.onclick = (e) => { e.stopPropagation(); e.preventDefault(); let current = parseFloat(valueDisplay.innerText) || 0; let newVal = Math.round((current + step) * 20) / 20; newVal = Math.max(-99.95, Math.min(99.95, newVal)); valueDisplay.innerText = newVal.toFixed(2); updateStrength(newVal); };
            strengthWidget.onmousedown = (e) => e.stopPropagation(); strengthWidget.onclick = (e) => e.stopPropagation();
            strengthWidget.appendChild(btnMinus); strengthWidget.appendChild(valueDisplay); strengthWidget.appendChild(btnPlus);

            // Info Button
            const infoBtn = document.createElement("div");
            infoBtn.innerText = "ℹ️"; 
            infoBtn.style.cssText = `position: absolute; right: 0px; top: -3px; font-size: 16px; cursor: pointer; padding: 2px; border-radius: 4px; color: #aaa; display: flex; align-items: center; justify-content: center; flex-shrink: 0; z-index: 5; filter: none; transform: translateY(-1px);`;
            if (!has_info) infoBtn.style.filter = "grayscale(100%)";
            
            // Prepare data for modal (Cache > Meta > Empty)
            let dataForModal = {};
            if (cachedMeta) dataForModal = cachedMeta;
            else if (lora.has_meta && lora.meta) dataForModal = lora.meta;
            else dataForModal = { name: lora.display_name };
            
            infoBtn.onclick = (e) => { e.stopPropagation(); openLoraInfoModal(dataForModal, displayName, loraKey, nodeRef); };

            topRow.appendChild(strengthWidget);
            controlsRow.appendChild(infoBtn);
            controlsRow.appendChild(topRow);

            // Recommended Strength Label
            let sMin = null, sMax = null;
            if (cachedMeta) { sMin = cachedMeta.strengthMin; sMax = cachedMeta.strengthMax; }
            else if (lora.has_meta && lora.meta) { sMin = lora.meta.strengthMin; sMax = lora.meta.strengthMax; }
            
            const hasMin = (sMin !== null && sMin !== undefined);
            const hasMax = (sMax !== null && sMax !== undefined);
            let recText = null;

            if (hasMin && hasMax) {
                const vMin = parseFloat(sMin).toFixed(2); const vMax = parseFloat(sMax).toFixed(2);
                recText = (vMin === vMax) ? `R.S. : ${vMin}` : `R.S. : ${vMin} - ${vMax}`;
            } else if (hasMin) { recText = `R.S. : ${parseFloat(sMin).toFixed(2)}`; }
            else if (hasMax) { recText = `R.S. : ${parseFloat(sMax).toFixed(2)}`; }

            const recLabel = document.createElement("div");
            recLabel.innerText = recText || "";
            recLabel.style.cssText = `font-size: 9px; color: ${CONFIG.COLORS.text_main}; text-align: center; white-space: nowrap; margin-top: 5px; font-weight: 700; letter-spacing: 0.5px; line-height: 1.2; min-height: 11px;`;
            controlsRow.appendChild(recLabel);

            card.append(imgContainer, nameSpan, controlsRow);

            // Remove Button (Only in custom tabs)
            let removeBtn = null;
            if (!isLibrary) {
                removeBtn = document.createElement("div");
                removeBtn.innerText = "❌";
                removeBtn.style.cssText = "font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; position:absolute; top:4px; right:4px; opacity:0; transition:opacity 0.2s; pointer-events:auto;";
                removeBtn.onclick = (e) => { e.stopPropagation(); if (confirm("Remove this LoRA from this tab?")) { removeLoraFromTab(nodeRef, currentTabId, loraKey); if (refreshCallback) refreshCallback(); } };
                removeBtn.onmouseenter = (e) => { e.stopPropagation(); removeBtn.style.opacity = "1"; };
                card.appendChild(removeBtn);
            }

            // Card Click (Toggle On/Off)
            card.onclick = (e) => { 
                if (e.target === strengthWidget || e.target === infoBtn || (removeBtn && e.target === removeBtn)) return; 
                const currentMap = nodeRef.properties.activeLorasMap || {}; 
                const currentState = currentMap[loraKey] || { on: false, strength: 1.0 }; 
                const newState = !currentState.on; 
                nodeRef.properties.activeLorasMap[loraKey] = { on: newState, strength: currentState.strength, name: lora.name, subfolder: lora.subfolder }; 
                syncLoraDataToWidget(nodeRef); 
                if (refreshCallback) refreshCallback(); 
            };

            // --- DRAG & DROP INTERNAL LOGIC ---
            
            // 1. DRAG START
            card.ondragstart = (e) => { 
                neuradDragState = "lora-card";
                e.dataTransfer.setData("application/json", JSON.stringify({ 
                    loraPath: loraKey, sourceTabId: currentTabId, index: index, dragType: "lora-card" 
                })); 
                e.dataTransfer.effectAllowed = "copyMove"; 
                card.style.opacity = "0.5"; 
                // Lock grid scroll
                gridScrollLockValue = gridContainer.scrollTop;
                gridScrollLockActive = true;
            };

            // 2. DRAG OVER (Visual Feedback)
            card.ondragover = (e) => {
                e.preventDefault(); e.stopPropagation();
                card.style.border = "1px solid #666"; // Reset
                if (neuradDragState === "lora-card") {
                    const rect = card.getBoundingClientRect();
                    const midX = rect.left + rect.width / 2;
                    if (e.clientX < midX) {
                        card.style.borderLeft = "3px solid #4da6ff";
                    } else {
                        card.style.borderRight = "3px solid #4da6ff";
                    }
                }
            };

            // 3. DRAG LEAVE
            card.ondragleave = (e) => {
                if (e.target === card) card.style.border = "1px solid #666";
            };

            // 4. DROP (Reorder or Add)
            card.ondrop = (e) => {
                e.preventDefault(); e.stopPropagation(); 
                card.style.border = "1px solid #666";
                const data = e.dataTransfer.getData("application/json"); 
                if (!data) return;
                
                try {
                    const payload = JSON.parse(data);
                    const targetPath = lora.relative_path;
                    
                    if (payload.sourceTabId === currentTabId) {
                        // Reorder within same tab
                        const currentList = currentTab.loras;
                        let oldIndex = currentList.findIndex(p => p.replace(/\\/g, '/') === payload.loraPath.replace(/\\/g, '/'));
                        let targetIndex = currentList.findIndex(p => p.replace(/\\/g, '/') === targetPath.replace(/\\/g, '/'));
                        
                        if (oldIndex !== -1 && targetIndex !== -1 && oldIndex !== targetIndex) {
                            const rect = card.getBoundingClientRect();
                            const insertBefore = (e.clientX < rect.left + rect.width / 2);
                            let finalIndex = insertBefore 
                                ? (oldIndex < targetIndex ? targetIndex - 1 : targetIndex) 
                                : (oldIndex < targetIndex ? targetIndex : targetIndex + 1);
                            
                            finalIndex = Math.max(0, Math.min(finalIndex, currentList.length));
                            const item = currentList.splice(oldIndex, 1)[0];
                            currentList.splice(finalIndex, 0, item);
                            saveTabsConfig(nodeRef);
                            if (refreshCallback) setTimeout(() => refreshCallback(), 50);
                        }
                    } else {
                        // Drop from different tab (Add)
                        if (currentTabId !== "library" && !currentTab.locked && !currentTab.loras.includes(payload.loraPath)) {
                            const rect = card.getBoundingClientRect();
                            const visualIndex = filteredLoras.indexOf(lora);
                            const insertBefore = (e.clientX < rect.left + rect.width / 2);
                            let targetIndex = insertBefore ? visualIndex : visualIndex + 1;
                            targetIndex = Math.max(0, Math.min(targetIndex, currentTab.loras.length));
                            
                            currentTab.loras.splice(targetIndex, 0, payload.loraPath);
                            saveTabsConfig(nodeRef);
                            if (refreshCallback) setTimeout(() => refreshCallback(), 50);
                        }
                    }
                } catch (err) { console.error("[Neurad] Card drop error:", err); }
            };
            
            // 5. DRAG END (Cleanup)
            card.ondragend = () => {
                neuradDragState = null;
                card.style.opacity = "1";
                card.style.border = "1px solid #666";
                gridScrollLockActive = false; // Unlock scroll
            };

            gridContainer.appendChild(card);
        });
    }
    container.appendChild(gridContainer);
}

// ============================================================================
// MODALS & POPUPS
// ============================================================================

// Stack of currently-open popups' close functions (most recent last).
// Lets Escape close only the topmost modal when several are stacked
// (e.g. Info modal opened on top of the floating panel).
const _popupStack = [];

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (_popupStack.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const topClose = _popupStack[_popupStack.length - 1];
    topClose();
});

/**
 * Creates a generic modal popup overlay.
 * Used as the base for both the Edit and Info modals.
 * 
 * @param {HTMLElement} contentElement - The DOM element to display inside the modal.
 * @param {string} title - The title displayed in the header.
 * @param {Function} onCloseCallback - Optional callback executed when the modal closes.
 * @param {string} width - CSS width value (e.g., "800px").
 * @param {string} height - CSS height value (e.g., "auto").
 * @returns {HTMLElement} The overlay element.
 */
function createPopup(contentElement, title, onCloseCallback = null, width = "800px", height = "auto") {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:2000; display:flex; justify-content:center; align-items:center; cursor:default;";

    const modal = document.createElement("div");
    modal.style.cssText = `background:${CONFIG.COLORS.bg_panel}; width:${width}; height:${height}; min-height:400px; max-width:98%; max-height:95vh; border-radius:8px; border:0px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 0 20px rgba(0,0,0,0.5); color:#eee; font-family:sans-serif; pointer-events:auto; position:relative;`;

    const header = document.createElement("div");
    header.style.cssText = `position: relative; padding: 0; background:${CONFIG.COLORS.bg_header}; border-bottom:1px solid ${CONFIG.COLORS.separator_header}; display:flex; align-items:center; flex-shrink:0; height: 50px;`;

    const h3 = document.createElement("h3");
    h3.innerText = title;
    h3.style.cssText = `color: ${CONFIG.COLORS.text_node_title}; margin:0; padding: 0 15px; font-size:20px; font-weight: 300; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`;

    const closeBtn = document.createElement("button");
    closeBtn.innerText = "✕";
    closeBtn.style.cssText = `
        font-size:20px; color: ${CONFIG.COLORS.text_node_title};
        position: absolute; right: 0; top: 0; bottom: 0;
        width: 45px; background: transparent; border: none;
        cursor: pointer; padding: 0; margin: 0;
        display: flex; align-items: center; justify-content: center;
        z-index: 10;
    `;

    const bgSpan = document.createElement("span");
    bgSpan.style.cssText = `
        position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        background: transparent; z-index: -1; transition: background 0.2s;
    `;
    closeBtn.appendChild(bgSpan);

    closeBtn.onmouseover = function() { bgSpan.style.background = CONFIG.COLORS.bg_close_hover; };
    closeBtn.onmouseout = function() { bgSpan.style.background = 'transparent'; };

    header.append(h3, closeBtn);

    contentElement.style.cssText = `flex: 1; overflow-y: auto; overflow-x: hidden; display: block; padding-top: 0px; padding-bottom: 0px; padding-left: 0px; padding-right: 0px; scrollbar-width: thin; scrollbar-color:${CONFIG.COLORS.bg_button} ${CONFIG.COLORS.bg_dark}; width: 100%; box-sizing: border-box;`;

    modal.append(header, contentElement);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const closePopup = () => {
        const stackIdx = _popupStack.indexOf(closePopup);
        if (stackIdx !== -1) _popupStack.splice(stackIdx, 1);
        if (onCloseCallback) onCloseCallback();
        document.removeEventListener('mousedown', handleOutsideClick);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    
    closeBtn.onclick = closePopup;
    _popupStack.push(closePopup);
    
    const handleOutsideClick = (e) => { if (overlay === e.target) closePopup(); };
    setTimeout(() => document.addEventListener('mousedown', handleOutsideClick), 10);
    
    return overlay;
}

// ============================================================================
// EDIT MODAL
// ============================================================================
/**
 * Opens the modal for editing LoRA metadata.
 * 
 * Logic:
 * 1. Fetches the freshest data available (Local Cache > Server Catalog > Passed Meta).
 * 2. Renders form fields: Name, Trigger Words, Cover Image, Strength Range.
 * 3. Handles "Get CivitAI Data" fetch.
 * 4. Saves changes to Local Cache and Server, then updates the UI.
 * 
 * @param {Object} meta - Initial metadata object (fallback).
 * @param {string} title - Default title.
 * @param {string} loraPath - Unique identifier for the LoRA.
 * @param {Object} nodeRef - The node instance.
 * @param {Function} onSaveCallback - Callback executed after successful save.
 */
function openLoraEditModal(meta, title, loraPath, nodeRef, onSaveCallback) {
    const contentBody = document.createElement("div");
    contentBody.style.cssText = `width: 100%; height: 100%; display: flex; flex-direction: column; gap: 20px; overflow-y: auto; padding: 20px; box-sizing: border-box; font-family: sans-serif; color: ${CONFIG.COLORS.text_main};`;

    // 1. FETCH FRESHEST DATA
    // Priority: Local Cache > Node Catalog > Passed Meta
    let freshData = null;
    if (typeof LocalCache !== 'undefined' && loraPath) {
        freshData = LocalCache.get(loraPath);
    }
    if (!freshData && nodeRef && nodeRef.properties._fullLoraCatalog) {
        const loraObj = nodeRef.properties._fullLoraCatalog.find(l => l.relative_path === loraPath);
        if (loraObj && loraObj.meta) freshData = loraObj.meta;
    }
    if (!freshData) {
        freshData = (meta && typeof meta === 'object') ? meta : { name: title };
    }

    // Create editable copy
    let editData = {
        name: freshData.name || title || "",
        trainedWords: freshData.trainedWords ? [...freshData.trainedWords] : [],
        strengthMin: freshData.strengthMin,
        strengthMax: freshData.strengthMax,
        comment: freshData.comment || "",
        images: freshData.images ? [...freshData.images] : [],
        hiddenImages: freshData.hiddenImages ? [...freshData.hiddenImages] : [],
        civitaiUrl: freshData.civitaiUrl,
        coverImage: freshData.coverImage || null,
        customImageUrl: freshData.customImageUrl || null
    };

    const formContainer = document.createElement("div");
    formContainer.style.cssText = "padding: 20px; display: flex; flex-direction: column; gap: 15px;";
    contentBody.appendChild(formContainer);

    // 2. FORM RENDERER
    const renderForm = () => {
        formContainer.innerHTML = "";
        
        // Header
        const headerDiv = document.createElement("div");
        headerDiv.innerHTML = `<strong style='font-size:16px; color:${CONFIG.COLORS.text_faded};'>Edit Mode</strong>`;
        formContainer.appendChild(headerDiv);

        // Field 1: Display Name
        const nameGroup = document.createElement("div");
        nameGroup.innerHTML = "<strong>Displayed Name</strong>";
        const nameInput = document.createElement("input");
        nameInput.type = "text"; nameInput.value = editData.name;
        nameInput.style.cssText = `width: 100%; padding: 8px; background: ${CONFIG.COLORS.bg_dark}; border: 1px solid ${CONFIG.COLORS.border_default}; color: ${CONFIG.COLORS.text_main}; border-radius: 8px; margin-top: 5px;`;
        nameInput.onchange = (e) => { editData.name = e.target.value; };
        nameGroup.appendChild(nameInput);
        formContainer.appendChild(nameGroup);

        // Field 2: Trigger Words
        const tagsGroup = document.createElement("div");
        tagsGroup.innerHTML = `<strong>Trigger Words</strong><div style='font-size:11px; color:${CONFIG.COLORS.text_faded}; margin-bottom:5px;'>Use semicolon as separator (;).</div>`;
        const tagsInput = document.createElement("textarea");
        tagsInput.value = editData.trainedWords.join("; ");
        tagsInput.style.cssText = `width: 100%; min-height: 100px; padding: 8px; background: ${CONFIG.COLORS.bg_dark}; border: 1px solid ${CONFIG.COLORS.border_default}; color: ${CONFIG.COLORS.text_main}; border-radius: 8px; margin-top: 5px; font-family: monospace; resize: none; overflow-y: hidden; box-sizing: border-box;`;
        
        const autoResize = () => { tagsInput.style.height = 'auto'; tagsInput.style.height = tagsInput.scrollHeight + 'px'; };
        tagsInput.addEventListener('input', autoResize);
        setTimeout(autoResize, 0);
        tagsInput.onchange = (e) => { editData.trainedWords = e.target.value.split(';').map(w => w.trim()).filter(w => w !== ""); };
        tagsGroup.appendChild(tagsInput);
        formContainer.appendChild(tagsGroup);

        // Field 3: Cover Image
        const imageSection = document.createElement("div");
        imageSection.innerHTML = `<strong>Cover Image</strong><div style='font-size:11px; color:${CONFIG.COLORS.text_faded}; margin-bottom:5px;'>Custom URL :</div>`;
        const urlGroup = document.createElement("div");
        const customUrlInput = document.createElement("input");
        customUrlInput.type = "text"; customUrlInput.placeholder = "https://...";
        customUrlInput.value = editData.customImageUrl || "";
        customUrlInput.style.cssText = `width: 100%; padding: 6px; background: ${CONFIG.COLORS.bg_dark}; border: 1px solid ${CONFIG.COLORS.border_default}; color: ${CONFIG.COLORS.text_main}; border-radius: 8px; font-size: 11px;`;
        customUrlInput.onchange = (e) => { 
            const val = e.target.value.trim(); 
            editData.customImageUrl = (val === "") ? null : val; 
            if (val) editData.coverImage = val; 
        };
        urlGroup.appendChild(customUrlInput);
        imageSection.appendChild(urlGroup);

        // Image Grid Selector
        if (editData.images && editData.images.length > 0) {
            urlGroup.style.cssText = "margin-bottom: 10px;";
            const gridDiv = document.createElement("div");
            gridDiv.style.cssText = `display: grid; grid-template-columns: repeat(auto-fill, minmax(60px, 1fr)); gap: 5px; max-height: 150px; overflow-y: auto; padding: 5px; background: ${CONFIG.COLORS.bg_dark}; border: 1px solid ${CONFIG.COLORS.border_default}; border-radius: 8px;`;
            const currentCoverUrl = editData.coverImage || (editData.customImageUrl ? editData.customImageUrl : getFirstVisibleImageUrl(editData.images, editData.hiddenImages));

            editData.images.forEach((img, idx) => {
                const isHidden = editData.hiddenImages.includes(img.url);
                const isSelected = (!isHidden && img.url === currentCoverUrl);

                const thumb = document.createElement("div");
                thumb.style.cssText = `position: relative; aspect-ratio: 1; background: #000; border: ${isSelected ? `2px solid ${CONFIG.COLORS.border_bright_blue}` : `1px solid ${CONFIG.COLORS.border_default}`}; border-radius: 3px; overflow: hidden; cursor: ${isHidden ? 'default' : 'pointer'}; opacity: ${isHidden ? '0.35' : (isSelected ? '1' : '0.7')};`;

                const imgEl = document.createElement("img");
                imgEl.src = img.url;
                imgEl.style.cssText = "width: 100%; height: 100%; object-fit: cover;";
                thumb.appendChild(imgEl);

                if (!isHidden) {
                    thumb.onclick = () => {
                        editData.coverImage = img.url;
                        editData.customImageUrl = null;
                        customUrlInput.value = "";
                        renderForm();
                    };
                } else {
                    thumb.title = "Hidden from the Info modal. Click the eye icon to show it again.";
                }

                // Hide/Show toggle -- independent of the cover-selection click above.
                const toggleBtn = document.createElement("button");
                toggleBtn.innerText = isHidden ? "🙈" : "👁";
                toggleBtn.title = isHidden ? "Hidden from the Info modal — click to show" : "Click to hide from the Info modal";
                toggleBtn.style.cssText = `position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; padding: 0; border: none; border-radius: 3px; background: rgba(0,0,0,0.65); color: #fff; font-size: 11px; line-height: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 5;`;
                toggleBtn.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (isHidden) {
                        editData.hiddenImages = editData.hiddenImages.filter(u => u !== img.url);
                    } else {
                        editData.hiddenImages.push(img.url);
                        // If we just hid the currently-selected cover, drop it so the
                        // form falls back to the next visible image instead of
                        // silently keeping a now-hidden image as the cover.
                        if (editData.coverImage === img.url) editData.coverImage = null;
                        if (editData.customImageUrl === img.url) { editData.customImageUrl = null; customUrlInput.value = ""; }
                    }
                    renderForm();
                };
                thumb.appendChild(toggleBtn);

                gridDiv.appendChild(thumb);
            });
            imageSection.appendChild(gridDiv);
            const helpText = document.createElement("div");
            helpText.innerText = "Click a thumbnail to set as cover. Click 👁 to hide an image from the Info modal (e.g. NSFW previews).";
            helpText.style.cssText = `font-size: 10px; color: ${CONFIG.COLORS.text_faded}; margin-top: 5px; text-align: center;`;
            imageSection.appendChild(helpText);
        }
        formContainer.appendChild(imageSection);

        // Field 4: Recommended Strength
        const strengthGroup = document.createElement("div");
        strengthGroup.innerHTML = `<strong>Recommended Strength</strong><div style='font-size:11px; color:${CONFIG.COLORS.text_faded}; margin-bottom:5px;'>Leave empty to hide</div>`;
        const strengthRow = document.createElement("div");
        strengthRow.style.cssText = "display: flex; gap: 10px; margin-top: 5px;";
        
        const inputMin = document.createElement("input");
        inputMin.type = "number"; inputMin.step = "0.05"; inputMin.placeholder = "Min";
        inputMin.value = (editData.strengthMin !== null && editData.strengthMin !== undefined) ? editData.strengthMin : "";
        inputMin.style.cssText = `flex: 1; padding: 8px; background: ${CONFIG.COLORS.bg_dark}; border: 1px solid ${CONFIG.COLORS.border_default}; color: ${CONFIG.COLORS.text_main}; border-radius: 8px;`;
        inputMin.onchange = (e) => { editData.strengthMin = (e.target.value === "") ? null : parseFloat(e.target.value); };

        const inputMax = document.createElement("input");
        inputMax.type = "number"; inputMax.step = "0.05"; inputMax.placeholder = "Max";
        inputMax.value = (editData.strengthMax !== null && editData.strengthMax !== undefined) ? editData.strengthMax : "";
        inputMax.style.cssText = `flex: 1; padding: 8px; background: ${CONFIG.COLORS.bg_dark}; border: 1px solid ${CONFIG.COLORS.border_default}; color: ${CONFIG.COLORS.text_main}; border-radius: 8px;`;
        inputMax.onchange = (e) => { editData.strengthMax = (e.target.value === "") ? null : parseFloat(e.target.value); };

        strengthRow.appendChild(inputMin); strengthRow.appendChild(inputMax);
        strengthGroup.appendChild(strengthRow);
        formContainer.appendChild(strengthGroup);

        // 3. ACTION BUTTONS
        const actionsRow = document.createElement("div");
        actionsRow.style.cssText = `display: flex; justify-content: space-between; align-items: center; margin-top: 20px; padding-top: 15px; gap: 10px;`;

        // Fetch CivitAI Button
        const fetchBtn = document.createElement("button");
        fetchBtn.innerText = "📥 Get CivitAI Data";
        fetchBtn.style.cssText = `background: ${CONFIG.COLORS.accent_blue_select}; color: ${CONFIG.COLORS.text_main}; padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 12px; white-space: nowrap;`;
        fetchBtn.onmouseover = () => { if(!fetchBtn.disabled) fetchBtn.style.background = CONFIG.COLORS.accent_blue_faded; };
        fetchBtn.onmouseout = () => { if(!fetchBtn.disabled) fetchBtn.style.background = CONFIG.COLORS.accent_blue_select; };
        
        fetchBtn.onclick = async () => {
            if (!loraPath) { alert("Error: Path missing"); return; }
            if (!confirm("Download will erase manual changes. Continue?")) return;
            
            fetchBtn.disabled = true; fetchBtn.innerText = "⏳...";
            try {
                const response = await fetch('/neurad/fetch-single-info', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: loraPath })
                });
                const result = await response.json();
                if (result.success && result.meta) {
                    editData.name = result.meta.name || editData.name;
                    editData.trainedWords = result.meta.trainedWords || editData.trainedWords;
                    editData.strengthMin = result.meta.strengthMin;
                    editData.strengthMax = result.meta.strengthMax;
                    editData.civitaiUrl = result.meta.civitaiUrl;
                    if (result.meta.images && result.meta.images.length > 0) {
                        editData.images = result.meta.images;
                        if (!editData.coverImage && !editData.customImageUrl) editData.coverImage = result.meta.images[0].url;
                    }
                    renderForm();
                } else { alert("Failure: " + (result.error || "No data")); }
            } catch (err) { alert("Error: " + err.message); }
            finally { fetchBtn.disabled = false; fetchBtn.innerText = "📥 Get CivitAI Data"; }
        };

        // Right Group (Cancel + Save)
        const rightGroup = document.createElement("div");
        rightGroup.style.cssText = "display: flex; gap: 10px;";

        const cancelBtn = document.createElement("button");
        cancelBtn.innerText = "Cancel";
        cancelBtn.style.cssText = `padding: 8px 16px; background: ${CONFIG.COLORS.bg_button}; color: ${CONFIG.COLORS.text_main}; border: none; border-radius: 8px; cursor: pointer; font-weight: bold;`;
        cancelBtn.onmouseover = () => { if(!cancelBtn.disabled) cancelBtn.style.background = CONFIG.COLORS.bg_button_hover; };
        cancelBtn.onmouseout = () => { if(!cancelBtn.disabled) cancelBtn.style.background = CONFIG.COLORS.bg_button; };
        cancelBtn.onclick = () => { 
            const overlay = contentBody.parentElement.parentElement;
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        };

        const saveBtn = document.createElement("button");
        saveBtn.innerText = "💾 Save";
        saveBtn.style.cssText = `background: ${CONFIG.COLORS.accent_blue_select}; color: ${CONFIG.COLORS.text_main}; padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 12px; white-space: nowrap;`;
        saveBtn.onmouseover = () => { if(!saveBtn.disabled) saveBtn.style.background = CONFIG.COLORS.accent_blue_faded; };
        saveBtn.onmouseout = () => { if(!saveBtn.disabled) saveBtn.style.background = CONFIG.COLORS.accent_blue_select; };
        
        saveBtn.onclick = async () => {
            if (!loraPath) { alert("Error: File path not found."); return; }
            saveBtn.disabled = true; saveBtn.innerText = "Saving...";

            try {
                const response = await fetch('/neurad/update-lora-info', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: loraPath, meta: editData })
                });
                if (!response.ok) throw new Error("Server error: " + response.status);
                const result = await response.json();

                if (result.success) {
                    // Update Local Cache
                    if (typeof LocalCache !== 'undefined') LocalCache.set(loraPath, editData);
                    
                    // Update Node Catalog in memory
                    const catalog = nodeRef.properties._fullLoraCatalog || [];
                    const loraObj = catalog.find(l => l.relative_path === loraPath);
                    if (loraObj) {
                        loraObj.has_meta = true;
                        if (!loraObj.meta) loraObj.meta = {};
                        loraObj.meta.name = editData.name;
                        loraObj.meta.strengthMin = editData.strengthMin;
                        loraObj.meta.strengthMax = editData.strengthMax;
                        loraObj.meta.trainedWords = editData.trainedWords;
                        loraObj.display_name = editData.name || loraObj.display_name;
                    }

                    // Clamp the card's active strength to the newly saved min/max range
                    clampCardStrengthToRange(nodeRef, loraPath, editData.strengthMin, editData.strengthMax, loraObj);
                    
                    syncLoraDataToWidget(nodeRef);
                    if (window.neuradRefreshCallback) window.neuradRefreshCallback();
                    if (onSaveCallback) onSaveCallback(editData);
                    
                    const overlay = contentBody.parentElement.parentElement;
                    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                    
                } else { throw new Error(result.error || "Failure"); }
            } catch (err) {
                alert("Save error: " + err.message);
                saveBtn.disabled = false; saveBtn.innerText = "💾 Save";
            }
        };

        rightGroup.appendChild(cancelBtn);
        rightGroup.appendChild(saveBtn);
        actionsRow.appendChild(fetchBtn);
        actionsRow.appendChild(rightGroup);
        formContainer.appendChild(actionsRow);
    };

    renderForm();
    createPopup(contentBody, "Edit: " + (editData.name || "LoRA"), null, "min(1300px, 80vw)", "auto");
}

// ============================================================================
// INFO MODAL (READ-ONLY)
// ============================================================================
/**
 * Opens the read-only modal for viewing LoRA details.
 * 
 * Features:
 * - Displays Trigger Words (clickable to copy to clipboard).
 * - Displays Images (clickable to zoom, shows metadata if available).
 * - Displays Recommended Strength.
 * - Provides link to CivitAI.
 * - Includes an "Edit" button to switch to edit mode.
 * 
 * @param {Object} meta - Metadata object.
 * @param {string} title - Display title.
 * @param {string} loraPath - Unique identifier.
 * @param {Object} nodeRef - The node instance.
 */
function openLoraInfoModal(meta, title, loraPath = null, nodeRef) {
    const contentBody = document.createElement("div");
    contentBody.style.cssText = `width: 100%; height: 100%; display: flex; flex-direction: column; gap: 20px; overflow-y: auto; padding: 20px; box-sizing: border-box; font-family: sans-serif; color: ${CONFIG.COLORS.text_main};`;

    // Internal renderer to allow dynamic updates (e.g., after editing)
    const renderViewContent = (dataToDisplay) => {
        contentBody.innerHTML = ""; 
        const formContainer = document.createElement("div");
        formContainer.style.cssText = "padding: 20px; display: flex; flex-direction: column; gap: 15px;";
        contentBody.appendChild(formContainer);

        // Header with File Path and Edit Button
        if (loraPath) {
            const editHeader = document.createElement("div");
            editHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 5px;";

            const fileNameLabel = document.createElement("span");
            fileNameLabel.innerText = loraPath;
            fileNameLabel.title = loraPath;
            fileNameLabel.style.cssText = `font-size: 10px; color: ${CONFIG.COLORS.text_faded}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; transform: translate(-6px, -20px);`;
            editHeader.appendChild(fileNameLabel);

            const editBtn = document.createElement("button");
            editBtn.innerText = "✏️ Edit";
            editBtn.style.cssText = `background: ${CONFIG.COLORS.accent_blue_select}; color: ${CONFIG.COLORS.text_main}; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 11px; white-space: nowrap; flex-shrink: 0;`;
            editBtn.onmouseover = () => { if(!editBtn.disabled) editBtn.style.background = CONFIG.COLORS.accent_blue_faded; };
            editBtn.onmouseout = () => { if(!editBtn.disabled) editBtn.style.background = CONFIG.COLORS.accent_blue_select; };
            
            editBtn.onclick = () => {
                openLoraEditModal(dataToDisplay, dataToDisplay.name, loraPath, nodeRef, (savedData) => {
                    // Update modal title
                    const overlay = contentBody.parentElement.parentElement;
                    if (overlay) {
                        const popupTitle = overlay.querySelector('h3');
                        if (popupTitle) popupTitle.innerText = (savedData.name || "LoRA Details");
                    }
                    // Refresh content
                    renderViewContent(savedData);
                });
            };
            editHeader.appendChild(editBtn);
            formContainer.appendChild(editHeader);
        }

        // 1. Trigger Words (Interactive Copy)
        if (dataToDisplay.trainedWords && dataToDisplay.trainedWords.length > 0) {
            const div = document.createElement("div");
            div.innerHTML = "<strong>Trigger Words:</strong>";
            const tagsDiv = document.createElement("div");
            tagsDiv.style.cssText = "display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px;";

            const activeWords = new Set();
            const syncClipboard = () => {
                const ordered = dataToDisplay.trainedWords.filter(w => activeWords.has(w));
                navigator.clipboard.writeText(ordered.join(", "));
            };

            dataToDisplay.trainedWords.forEach(word => {
                const span = document.createElement("span");
                span.innerText = word;
                span.style.cssText = `background: ${CONFIG.COLORS.bg_toggle}; padding: 4px 8px; border-radius: 4px; font-size: 11px; color: ${CONFIG.COLORS.text_main}; border: 1px solid ${CONFIG.COLORS.border_default}; cursor: pointer;`;
                span.onmouseover = () => { if (!activeWords.has(word)) span.style.background = CONFIG.COLORS.bg_toggle_faded; };
                span.onmouseout = () => { if (!activeWords.has(word)) span.style.background = CONFIG.COLORS.bg_toggle; };
                span.onclick = () => { 
                    if (activeWords.has(word)) {
                        activeWords.delete(word);
                        span.style.background = CONFIG.COLORS.bg_toggle;
                        span.style.borderColor = CONFIG.COLORS.border_default;
                    } else {
                        activeWords.add(word);
                        span.style.background = CONFIG.COLORS.accent_blue_select;
                        span.style.borderColor = CONFIG.COLORS.accent_blue_select;
                    }
                    syncClipboard();
                };
                tagsDiv.appendChild(span);
            });
            div.appendChild(tagsDiv);
            formContainer.appendChild(div);
        }

        // 2. Images Gallery
        const visibleImages = (dataToDisplay.images || []).filter(img => !(dataToDisplay.hiddenImages || []).includes(img.url));
        if (visibleImages.length > 0) {
            const sectionDiv = document.createElement("div");
            sectionDiv.innerHTML = "<strong>Images:</strong>";
            const scrollContainer = document.createElement("div");
            scrollContainer.style.cssText = `display: flex; flex-direction: row; gap: 10px; overflow-x: auto; overflow-y: hidden; padding: 10px 0; width: 100%;margin: 0 auto; scrollbar-width: thin; scrollbar-color:${CONFIG.COLORS.bg_button} ${CONFIG.COLORS.bg_dark}; box-sizing: border-box;`;
            
            const currentCoverUrl = dataToDisplay.customImageUrl || dataToDisplay.coverImage || getFirstVisibleImageUrl(dataToDisplay.images, dataToDisplay.hiddenImages);

            visibleImages.forEach((img, index) => {
                const imgWrapper = document.createElement("div");
                imgWrapper.style.cssText = "flex: 0 0 auto; display: flex; flex-direction: column; background: transparent; border-radius: 8px; overflow: hidden; border: 1px solid #333; position: relative; max-width: 100%;";
                
                if (currentCoverUrl && img.url === currentCoverUrl) {
                    const badge = document.createElement("div");
                    badge.innerText = "Cover Image";
                    badge.style.cssText = `position: absolute; top: 4px; left: 4px; background: ${CONFIG.COLORS.accent_blue_select}; color: white; font-size: 9px; padding: 2px 6px; border-radius: 3px; font-weight: bold; z-index: 10;`;
                    imgWrapper.appendChild(badge);
                }
                
                const imgEl = document.createElement("img");
                imgEl.src = img.url;
                imgEl.style.cssText = "display: block; height: 200px; width: auto; object-fit: contain; cursor: pointer;";
                
                imgEl.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (img.positive) {
                        // Image with Metadata
                        const imgBox = document.createElement("div");
                        imgBox.style.cssText = `display: flex; align-items: flex-start; justify-content: center; background: transparent; overflow: visible; width: fit-content;`;
                        const viewImg = document.createElement("img");
                        viewImg.style.cssText = `max-width: max(300px, calc(95vw - 430px)); max-height: 75vh; width: auto; height: auto; object-fit: contain; display: block;`;
                        imgBox.appendChild(viewImg);

                        const textBox = document.createElement("div");
                        textBox.style.cssText = `width: 400px; min-width: 400px; background: ${CONFIG.COLORS.bg_dark}; display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; box-sizing: border-box;`;
                        const txtHeader = document.createElement("div");
                        txtHeader.innerText = "Metadata";
                        txtHeader.style.cssText = `padding: 15px; background: transparent; color: ${CONFIG.COLORS.text_main}; font-weight: bold; font-size: 14px; flex-shrink: 0;`;
                        const txtBody = document.createElement("div");
                        txtBody.innerText = img.positive;
                        txtBody.style.cssText = `flex: 1; padding: 15px; overflow-y: auto; background: ${CONFIG.COLORS.bg_dark}; border-top: 1px solid ${CONFIG.COLORS.separator_header}; font-family: monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; scrollbar-width: thin; scrollbar-color:${CONFIG.COLORS.bg_button} ${CONFIG.COLORS.bg_dark};`;
                        
                        const copyBtn = document.createElement("button");
                        copyBtn.innerText = "📋 Copy Metadata";
                        copyBtn.style.cssText = `width: 120px; margin: 10px 15px; align-self: flex-start; background: ${CONFIG.COLORS.accent_blue_select}; color: ${CONFIG.COLORS.text_main}; padding: 6px 12px; border: none; border-radius: 8px; cursor: pointer; font-size: 11px; flex-shrink: 0;`;
                        copyBtn.onmouseover = () => { copyBtn.style.background = CONFIG.COLORS.accent_blue_faded; };
                        copyBtn.onmouseout = () => { copyBtn.style.background = CONFIG.COLORS.accent_blue_select; };
                        copyBtn.onclick = function() {
                            navigator.clipboard.writeText(img.positive);
                            const originalText = copyBtn.innerText;
                            copyBtn.innerText = "✅ Copied !";
                            copyBtn.style.backgroundColor = CONFIG.COLORS.border_bright_blue;
                            setTimeout(() => { copyBtn.innerText = originalText; copyBtn.style.backgroundColor = CONFIG.COLORS.accent_blue_select; }, 400);
                        };

                        textBox.appendChild(txtHeader); textBox.appendChild(txtBody); textBox.appendChild(copyBtn);

                        const rowContainer = document.createElement("div");
                        rowContainer.style.cssText = `display: flex; flex-direction: row; align-items: flex-start; width: fit-content; max-width: 95vw; height: fit-content; background: #111; overflow: hidden; box-sizing: border-box;`;
                        rowContainer.appendChild(imgBox); rowContainer.appendChild(textBox);

                        // Sync text box height to image height
                        const syncTextBoxHeight = () => {
                            const h = viewImg.getBoundingClientRect().height;
                            if (h > 0) textBox.style.height = h + "px";
                        };
                        viewImg.onload = () => requestAnimationFrame(syncTextBoxHeight);
                        viewImg.src = img.url;

                        const zoomContent = document.createElement("div");
                        zoomContent.style.cssText = "width: 100%; height: 100%; display: flex; justify-content: center; align-items: center;";
                        zoomContent.appendChild(rowContainer);
                        createPopup(zoomContent, "Image Details", null, "fit-content", "fit-content");
                    } else {
                        // Image without Metadata
                        const zoomContent = document.createElement("div");
                        zoomContent.style.cssText = "display: flex; align-items: center; justify-content: center; background: #000; padding: 20px;";
                        const viewImg = document.createElement("img");
                        viewImg.src = img.url;
                        viewImg.style.cssText = "max-width: 90vw; max-height: 85vh; width: auto; height: auto; object-fit: contain;";
                        zoomContent.appendChild(viewImg);
                        createPopup(zoomContent, "Image", null, "fit-content", "fit-content");
                    }
                };
                
                if (img.positive) {
                    const indicator = document.createElement("div");
                    indicator.innerText = "📝";
                    indicator.style.cssText = "position: absolute; bottom: 4px; right: 4px; background: transparent; color: #fff; font-size: 12px; padding: 2px 5px; border-radius: 3px; pointer-events: none; z-index: 20; opacity: 1;";
                    imgWrapper.appendChild(indicator);
                }
                imgWrapper.appendChild(imgEl);
                scrollContainer.appendChild(imgWrapper);
            });
            sectionDiv.appendChild(scrollContainer);
            formContainer.appendChild(sectionDiv);
        }

        // 3. Recommended Strength
        const hasMin = (dataToDisplay.strengthMin !== null && dataToDisplay.strengthMin !== undefined);
        const hasMax = (dataToDisplay.strengthMax !== null && dataToDisplay.strengthMax !== undefined);
        if (hasMin || hasMax) {
            let text = "";
            if (hasMin && hasMax) {
                const vMin = parseFloat(dataToDisplay.strengthMin).toFixed(2);
                const vMax = parseFloat(dataToDisplay.strengthMax).toFixed(2);
                text = (vMin === vMax) ? `${vMin}` : `${vMin} - ${vMax}`;
            } else if (hasMin) text = parseFloat(dataToDisplay.strengthMin).toFixed(2);
            else if (hasMax) text = parseFloat(dataToDisplay.strengthMax).toFixed(2);
            
            const div = document.createElement("div");
            div.style.cssText = `padding: 10px; background: transparent; color: ${CONFIG.COLORS.text_main};`;
            div.innerHTML = `<strong>Recommended Strength:</strong> ${text}`;
            formContainer.appendChild(div);
        }

        // 4. CivitAI Link
        if (dataToDisplay.civitaiUrl) {
            const linkContainer = document.createElement("div");
            linkContainer.style.cssText = `margin-top: 10px; padding-top: 15px; border-top: 1px solid ${CONFIG.COLORS.separator_header};`;
            const link = document.createElement("a");
            link.href = dataToDisplay.civitaiUrl; link.target = "_blank";
            link.innerText = "View on CivitAI ↗";
            link.style.cssText = `color: ${CONFIG.COLORS.border_bright_blue}; text-decoration: none; font-weight: bold; font-size: 14px;`;
            linkContainer.appendChild(link);
            formContainer.appendChild(linkContainer);
        }
    };

    // Initialize Data
    let initialData = {};
    if (meta && typeof meta === 'object') {
        initialData = { ...meta };
    } else {
        initialData = { name: title };
    }
    if (!initialData.name) initialData.name = title || "Unknown";
    if (!initialData.trainedWords) initialData.trainedWords = [];
    if (!initialData.images) initialData.images = [];

    renderViewContent(initialData);
    createPopup(contentBody, initialData.name || "LoRA Details", null, "min(1400px, 85vw)", "auto");
}

// ============================================================================
// SIZE & SYNC UTILITIES
// ============================================================================

/**
 * Enforces a minimum size for the ComfyUI node based on its content.
 * Calculates required width based on the longest active LoRA name.
 * Calculates required height based on the number of active LoRAs and widget positions.
 * 
 * @param {Object} node - The ComfyUI node instance.
 * @param {boolean} immediate - If true, executes immediately; otherwise, debounces the resize.
 */
function enforceMinSize(node, immediate = false) {
    if (!node || !node.size) return;
    if (immediate && node._resizeTimer) { clearTimeout(node._resizeTimer); node._resizeTimer = null; }

    const executeEnforce = () => {
        if (!node || !node.size) return;
        const names = node.properties._cachedActiveDisplayNames || [];
        const tempCanvas = document.createElement('canvas');
        const ctx = tempCanvas.getContext('2d');
        if (!ctx) return;
        ctx.font = "12px sans-serif";

        // Calculate minimum width based on text length
        let maxTextWidth = 0;
        const listToCheck = names.length > 0 ? names : ["No active LoRAs"];
        for (let i = 0; i < listToCheck.length; i++) {
            const w = ctx.measureText(listToCheck[i]).width;
            if (w > maxTextWidth) maxTextWidth = w;
        }
        const finalMinWidth = Math.max(maxTextWidth + 24, 200);

        // Calculate minimum height based on widget stack and list length
        let startY = 40;
        if (node.widgets && node.widgets.length > 0) {
            const lastWidget = node.widgets[node.widgets.length - 1];
            if (lastWidget && lastWidget.y !== undefined && lastWidget.height !== undefined) {
                startY = lastWidget.y + lastWidget.height + 10;
            }
        }
        const lineCount = names.length > 0 ? names.length : 1;
        const finalMinHeight = Math.max(startY + (lineCount * 16) + 20, 100);

        // Apply constraints if current size is too small
        let needsUpdate = false;
        if (node.size[0] < finalMinWidth) { node.size[0] = finalMinWidth; needsUpdate = true; }
        if (node.size[1] < finalMinHeight) { node.size[1] = finalMinHeight; needsUpdate = true; }

        if (needsUpdate && node.setDirtyCanvas) {
            node.setDirtyCanvas(true, true);
        }
    };

    if (immediate) {
        executeEnforce();
    } else {
        if (node._resizeTimer) clearTimeout(node._resizeTimer);
        node._resizeTimer = setTimeout(executeEnforce, 150);
    }
}

/**
 * FAIL-SAFE: Validates every entry in the node's activeLorasMap against the real,
 * freshly-loaded catalog from disk. An entry is considered orphaned/corrupted if:
 *   - No file in the catalog matches its relative_path anymore (deleted/moved/renamed), OR
 *   - The stored entry itself is malformed (missing the fields needed to re-toggle it
 *     off or to serialize it to the backend: `name`, and a numeric `strength`).
 *
 * Any orphaned entry is purged from activeLorasMap AND from the metadata cache
 * (LocalCache), so it is dropped entirely and treated as a brand-new LoRA the next
 * time it (or a file with the same name) shows up in the catalog. This prevents the
 * "stuck active LoRA with no card to turn it off" situation.
 *
 * Must be called AFTER `nodeRef.properties._fullLoraCatalog` has been populated with
 * a fresh catalog (i.e. right after loadLoraList() resolves), since that's the only
 * moment we actually know which files exist on disk.
 *
 * @param {Object} nodeRef - The node instance.
 * @param {Array} fullCatalog - The freshly loaded LoRA catalog.
 * @returns {Array<string>} The list of purged keys (empty if nothing was corrupted).
 */
function purgeOrphanedActiveLoras(nodeRef, fullCatalog) {
    const activeMap = nodeRef.properties.activeLorasMap;
    if (!activeMap || !Array.isArray(fullCatalog)) return [];

    const catalogPaths = new Set(fullCatalog.filter(l => l && l.relative_path).map(l => l.relative_path));
    const purgedKeys = [];

    for (const key of Object.keys(activeMap)) {
        const entry = activeMap[key];
        const fileExists = catalogPaths.has(key);
        const entryIsWellFormed = entry && typeof entry.name === 'string' && entry.name.length > 0 && typeof entry.strength === 'number' && !isNaN(entry.strength);

        if (!fileExists || !entryIsWellFormed) {
            purgedKeys.push(key);
            delete activeMap[key];
            if (typeof LocalCache !== 'undefined') LocalCache.delete(key);
        }
    }

    if (purgedKeys.length > 0) {
        console.warn(`[Neurad] Fail-safe: purged ${purgedKeys.length} orphaned/corrupted active LoRA entr${purgedKeys.length === 1 ? 'y' : 'ies'}:`, purgedKeys);
        syncLoraDataToWidget(nodeRef);
    }

    return purgedKeys;
}

/**
 * Synchronizes the active LoRA state from the node's internal map to the hidden widget.
 * This ensures the data is passed correctly to the backend when the workflow runs.
 * Also updates the cached display names for the node's background rendering.
 * 
 * @param {Object} nodeRef - The ComfyUI node instance.
 */
/**
 * Clamps a card's active strength (in nodeRef.properties.activeLorasMap) to
 * the given [strengthMin, strengthMax] range, defaulting the baseline to 1.0
 * if no active entry exists yet. Shared by both the edit-modal Save handler
 * and the initial CivitAI auto-fetch, so a freshly-fetched recommendation is
 * applied immediately rather than only once the user opens/saves the modal.
 * Does nothing if neither bound is a valid number. Does NOT call
 * syncLoraDataToWidget itself -- callers should do that afterward if needed.
 *
 * @param {Object} nodeRef - The node instance.
 * @param {string} loraPath - The LoRA's relative_path (activeLorasMap key).
 * @param {number|null} strengthMin
 * @param {number|null} strengthMax
 * @param {Object} [loraObj] - Optional catalog entry, used for name/subfolder when creating a new entry.
 */
function clampCardStrengthToRange(nodeRef, loraPath, strengthMin, strengthMax, loraObj) {
    const hasMin = (typeof strengthMin === 'number' && !isNaN(strengthMin));
    const hasMax = (typeof strengthMax === 'number' && !isNaN(strengthMax));
    if (!hasMin && !hasMax) return;

    const activeMap = nodeRef.properties.activeLorasMap || (nodeRef.properties.activeLorasMap = {});
    const existingState = activeMap[loraPath];
    let newStrength = (existingState && typeof existingState.strength === 'number') ? existingState.strength : 1.0;

    if (hasMin && newStrength < strengthMin) newStrength = strengthMin;
    if (hasMax && newStrength > strengthMax) newStrength = strengthMax;

    if (existingState) {
        existingState.strength = newStrength;
    } else {
        activeMap[loraPath] = {
            on: false,
            strength: newStrength,
            name: loraObj ? loraObj.name : undefined,
            subfolder: loraObj ? loraObj.subfolder : undefined
        };
    }
}

function syncLoraDataToWidget(nodeRef) {
    const loraMap = nodeRef.properties.activeLorasMap || {};
    const fullCatalog = nodeRef.properties._fullLoraCatalog || [];
    const activeList = [];
    const activeDisplayNames = [];

    const sortedKeys = Object.keys(loraMap).sort();
    for (const key of sortedKeys) {
        const item = nodeRef.properties.activeLorasMap[key];
        if (item && item.on) {
            const fullLoraObj = fullCatalog.find(lora => lora.relative_path === key);
            let finalDisplayName = key.split('/').pop();
            
            // Prioritize metadata name for display
            if (fullLoraObj) {
                if (fullLoraObj.has_meta && fullLoraObj.meta && fullLoraObj.meta.name) {
                    finalDisplayName = fullLoraObj.meta.name;
                } else if (fullLoraObj.display_name) {
                    finalDisplayName = fullLoraObj.display_name;
                }
            }
            
            activeDisplayNames.push(`${finalDisplayName} (${item.strength})`);
            activeList.push({
                name: item.name,
                subfolder: item.subfolder,
                strength_model: item.strength,
                strength_clip: item.strength
            });
        }
    }

    nodeRef.properties._cachedActiveDisplayNames = activeDisplayNames;

    // Update the hidden string widget with JSON data
    const hiddenWidget = nodeRef.widgets.find(w => w.name === "lora_data");
    if (hiddenWidget) {
        const jsonValue = JSON.stringify(activeList);
        hiddenWidget.value = jsonValue;
        if (hiddenWidget.callback) hiddenWidget.callback(jsonValue);
    } else {
        console.error("[Neurad] CRITICAL: Widget 'lora_data' not found!");
    }

    nodeRef.setDirtyCanvas(true, true);
    enforceMinSize(nodeRef, true);
}

/**
 * Fetches the list of available LoRAs from the Python backend.
 * @returns {Promise<Array>} List of LoRA objects.
 */
async function loadLoraList() {
    try {
        const response = await fetch('/neurad/get-loras');
        if (!response.ok) throw new Error("Network error: " + response.status);
        return await response.json();
    } catch (error) {
        console.error("[Neurad] Failed to load LoRAs:", error);
        return [];
    }
}

/**
 * Performs a complete reset of the cache system.
 * Clears LocalStorage, memory cache, and requests server-side disk deletion.
 * 
 * @param {Object} nodeRef - The node instance.
 * @param {Function} refreshCallback - Callback to refresh UI after reset.
 */
async function resetAllCache(nodeRef, refreshCallback) {
    if (!confirm("WARNING: This action is irreversible.\n\nThe following data will be permanently deleted:\nAll cached metadata (Names, Trigger Words, Images, Strength Recommendations).\nLocal disk saves.\nLocal browser cache.\n\nYou will need to re-download or manually re-enter the data for every LoRA.\n\nContinue?")) {
        return;
    }

    console.log("[Neurad] Starting full purge...");

    // 1. Clear Browser LocalStorage
    localStorage.removeItem(STORAGE_KEY);
    LocalCache.data = {}; 
    console.log("[Neurad] Browser LocalStorage cleared.");

    // 2. Request Server Disk Purge
    try {
        const response = await fetch('/neurad/reset-cache', { method: 'POST' });
        const result = await response.json();
        
        if (result.success) {
            console.log("[Neurad] Server disk cache purged successfully.");
        } else {
            console.warn("[Neurad] Server purge reported issues:", result);
        }
    } catch (e) {
        console.error("[Neurad] CRITICAL: Failed to contact server for purge", e);
        alert("Server connection error.\nCache deletion may be incomplete. Some files might still remain.");
    }

    // 3. Refresh UI
    if (refreshCallback) {
        refreshCallback(); 
    }
    
    alert("Cache cleared successfully\n\nRefresh the page or the interface to ensure no residual data is present.");
}

// ============================================================================
// MAIN UI ENTRY POINT: FLOATING PANEL
// ============================================================================
/**
 * Creates and opens the main floating panel (Modal) for the Visual LoRA Loader.
 * 
 * Workflow:
 * 1. Closes any existing panel instance.
 * 2. Creates the modal overlay and "Clear Cache" button.
 * 3. Loads data sequentially: LocalCache (Memory/Disk) -> LoRA Catalog (Server).
 * 4. Initializes the Search Bar, Tabs, and Grid components.
 * 5. Sets up the global refresh callback.
 * 
 * @param {Object} nodeRef - The ComfyUI node instance.
 */
function createFloatingPanel(nodeRef) {
    // Initialize default tab config if missing
    if (!nodeRef.properties.tabsConfig) {
        nodeRef.properties.tabsConfig = {
            activeTabId: "library",
            tabs: [{ id: "library", name: "Library", locked: true, type: "dynamic", loras: [] }]
        };
    }

    // Close existing panel if open
    if (nodeRef.neuradPanelOverlay && document.body.contains(nodeRef.neuradPanelOverlay)) {
        const closeBtn = nodeRef.neuradPanelOverlay.querySelector("button");
        if(closeBtn) closeBtn.click();
    }

    const contentBody = document.createElement("div");
    contentBody.style.cssText = "display:flex; flex-direction:column; height:100%; overflow:hidden;";
    
    const loadingDiv = document.createElement("div");
    loadingDiv.innerText = "Refreshing LoRA catalog...";
    loadingDiv.style.cssText = `color: ${CONFIG.COLORS.bg_panel}; text-align:center; margin-top:20px; font-size:14px;`;
    contentBody.appendChild(loadingDiv);

    // Create the main modal overlay (Width forced to min(1200px, 90vw) for better grid fit)
    const overlay = createPopup(
        contentBody, 
        "Visual LoRA Loader", 
        () => { nodeRef.neuradPanelOverlay = null; }, 
        "min(1200px, 90vw)", 
        "85vh"
    );
    
    nodeRef.neuradPanelOverlay = overlay;

    // --- CLEAR CACHE BUTTON (Hidden by default, activates on long hover) ---
    const purgeBtn = document.createElement("button");
    purgeBtn.innerHTML = `⚠️ Clear Cache`;
    purgeBtn.disabled = true; // Initially disabled for safety

    // Dormant Style
    purgeBtn.style.cssText = `
        position: relative; align-self: flex-start; margin: 0px;
        z-index: 100; background: transparent;
        color: ${CONFIG.COLORS.text_faded}; border: none;
        font-size: 9px; font-weight: bold; cursor: default;
        white-space: nowrap; outline: none;
        transition: all 0.3s ease; opacity: 0.05;
    `;

    let activationTimer = null;

    // Activate on Long Hover (1 second)
    purgeBtn.onmouseenter = function() {
        activationTimer = setTimeout(() => {
            this.disabled = false;
            this.style.cssText = `
                position: relative; align-self: flex-start; margin: 0px;
                z-index: 100; background: red; color: white;
                border: none; font-size: 9px; font-weight: bold;
                cursor: pointer; white-space: nowrap; outline: none;
                transition: all 0.3s ease; opacity: 1;
            `;
        }, 1000);
    };

    // Deactivate on Mouse Leave
    purgeBtn.onmouseleave = function() {
        if (activationTimer) clearTimeout(activationTimer);
        this.disabled = true;
        this.style.cssText = `
            position: relative; align-self: flex-start; margin: 0px;
            z-index: 100; background: transparent;
            color: ${CONFIG.COLORS.text_faded}; border: none;
            font-size: 9px; font-weight: bold; cursor: default;
            white-space: nowrap; outline: none;
            transition: all 0.3s ease; opacity: 0.05;
        `;
    };

    // Click Handler: Execute Cache Purge
    purgeBtn.onclick = async function(e) {
        if (this.disabled) return;
        e.stopPropagation(); e.preventDefault();		
        
        if (!confirm("WARNING: This action is irreversible.\n\nThe following data will be permanently deleted:\nAll cached metadata (Images, Trigger Words).\nLocal disk saves.\nLocal browser cache.\n\nContinue?")) {
            return;
        }

        try {
            // 1. Clear Browser LocalStorage
            localStorage.removeItem(STORAGE_KEY);
            if (typeof LocalCache !== 'undefined') LocalCache.data = {};

            // 2. Call Server API to clear disk files
            const response = await fetch('/neurad/reset-cache', { 
                method: 'POST', headers: { 'Content-Type': 'application/json' }
            });
            
            if (!response.ok) throw new Error("Server error: " + response.status);
            const result = await response.json();

            if (result.success) {
                alert("Cache cleared successfully\n\nRefresh the page or the interface to ensure no residual data is present.");
                if (typeof refreshUI === 'function') refreshUI();
            } else {
                throw new Error(result.error || "Unknown error");
            }
        } catch (err) {
            console.error("[Neurad] CRITICAL ERROR:", err);
            alert("An error happened during the clearing: " + err.message);
        }
        
        // Reset button state
        this.disabled = true;
        this.style.background = "transparent";
        this.style.opacity = "0.6";
    };

    // --- SEQUENTIAL DATA LOADING ---
    
    // Step 2: Load Catalog and Render UI
    const proceedWithCatalog = () => {
        console.log("[Neurad] Step 2: Loading LoRA Catalog...");
        
        loadLoraList().then(fullCatalog => {
            nodeRef.properties._fullLoraCatalog = fullCatalog;
            console.log(`[Neurad] Catalog loaded: ${fullCatalog.length} LoRAs.`);

            // FAIL-SAFE: drop any "active" LoRA that no longer has a matching file
            // (or whose stored entry is malformed) so it can't get permanently stuck on.
            purgeOrphanedActiveLoras(nodeRef, fullCatalog);

            // Remove loading indicator
            if (loadingDiv.parentNode) contentBody.removeChild(loadingDiv);

            const mainContainer = document.createElement("div");
            mainContainer.style.cssText = "display:flex; flex-direction:column; height:100%; overflow:hidden;";
            mainContainer.appendChild(purgeBtn);
            contentBody.appendChild(mainContainer);

            // Initialize Search Config
            if (!nodeRef.properties.searchConfig) {
                nodeRef.properties.searchConfig = { query: "", excludeQuery: "", filters: [], lastActiveField: "positive" };
            }
            const config = nodeRef.properties.searchConfig;
            if (!Array.isArray(config.filters)) config.filters = [];
            // --- UPDATED: Added "no_tab" to the list of valid filters ---
            const validFilters = ["on", "off", "has_meta", "no_meta", "no_tab"];
            // -----------------------------------------------------------
            config.filters = config.filters.filter(f => validFilters.includes(f));

            // Define Refresh UI Function
            const refreshUI = () => {
                // Build new content in a detached fragment (prevents flickering)
                const staging = document.createElement("div");
                staging.appendChild(purgeBtn);
                
                // Render components: Scroll positions are now handled internally by reading nodeRef.properties
                renderSearchBar(nodeRef, staging, fullCatalog, refreshUI);
                renderTabsBar(nodeRef, staging, fullCatalog, refreshUI, refreshUI); 
                renderLoraGrid(nodeRef, fullCatalog, staging, refreshUI);

                // Atomic swap
                mainContainer.replaceChildren(...staging.childNodes);
            };
            
            window.neuradRefreshCallback = refreshUI; 
            refreshUI();
            
        }).catch(err => {
            console.error("[Neurad] Failed to load catalog", err);
            loadingDiv.innerText = "Error loading catalog.";
        });
    };

    // Step 1: Load/Restore Cache
    console.log("[Neurad] Step 1: Checking LocalCache status...");
    
    if (LocalCache.data && Object.keys(LocalCache.data).length > 0) {
        console.log("[Neurad] Cache already in memory. Proceeding.");
        proceedWithCatalog();
    } else {
        console.log("[Neurad] Cache empty. Triggering restore from disk...");
        LocalCache.restoreFromDisk().then(() => {
            console.log("[Neurad] Restore finished. Proceeding.");
            proceedWithCatalog();
        }).catch(e => {
            console.warn("[Neurad] Restore failed, proceeding anyway.", e);
            proceedWithCatalog();
        });
    }
}

// ============================================================================
// HELPER: FETCH SINGLE INFO
// ============================================================================
/**
 * Triggers a fetch request for a single LoRA's metadata from CivitAI.
 * Updates the UI card with loading states, success, or error messages.
 * 
 * @param {Object} nodeRef - The node instance.
 * @param {Object} lora - The LoRA object to fetch info for.
 * @param {HTMLElement} containerElement - The DOM element representing the card's image area.
 * @param {Function} refreshCallback - Callback to refresh the grid upon success.
 */
async function triggerFetchSingleInfo(nodeRef, lora, containerElement, refreshCallback) {
    // 1. Visual Feedback: Loading State
    const originalContent = containerElement.innerHTML;
    containerElement.innerHTML = `
        <div style="font-size:24px; color:#4da6ff;">⏳</div>
        <div style="font-size:10px; color:#aaa; font-weight:bold;">Extracting ID...</div>
    `;
    containerElement.style.pointerEvents = "none"; 
    containerElement.style.background = "#222";

    try {
        // Call Backend to fetch and parse CivitAI data
        const response = await fetch('/neurad/fetch-single-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: lora.relative_path })
        });

        const result = await response.json();

        if (result.success && result.meta) {
            // SUCCESS: 
            // 1. Save to LocalStorage (triggers disk backup automatically)
            LocalCache.set(lora.relative_path, result.meta);
            
            // 2. Update in-memory object for immediate UI reflection
            lora.has_meta = true;
            lora.meta = result.meta;

            // 3. Snap the card's active strength into the freshly-fetched range
            //    right away, rather than waiting for an edit-modal Save.
            clampCardStrengthToRange(nodeRef, lora.relative_path, result.meta.strengthMin, result.meta.strengthMax, lora);
            syncLoraDataToWidget(nodeRef);
            
            // 4. Refresh UI
            if (refreshCallback) {
                refreshCallback(); 
            }
        } else {
            // FAILURE: Display error
            const errorMsg = result.error || "Failed to fetch";
            containerElement.innerHTML = `
                <div style="font-size:24px; color:#ff6b6b;">⚠️</div>
                <div style="font-size:9px; color:#ff6b6b; text-align:center; padding:2px; max-width:90%;">${errorMsg}</div>
                <div style="font-size:9px; color:#aaa; margin-top:4px;">Click to retry</div>
            `;
            containerElement.style.pointerEvents = "auto";
            containerElement.style.background = "#2a2a2a";
            containerElement.onclick = (e) => {
                e.stopPropagation();
                triggerFetchSingleInfo(nodeRef, lora, containerElement, refreshCallback);
            };
        }
    } catch (e) {
        // NETWORK ERROR
        containerElement.innerHTML = `
            <div style="font-size:24px; color:#ff6b6b;">❌</div>
            <div style="font-size:9px; color:#ff6b6b;">Network Error</div>
        `;
        containerElement.style.pointerEvents = "auto";
        containerElement.onclick = (e) => {
            e.stopPropagation();
            triggerFetchSingleInfo(nodeRef, lora, containerElement, refreshCallback);
        };
    }
}

// ============================================================================
// NODE REGISTRATION
// ============================================================================
app.registerExtension({
    name: "Neurad.VisualLora",
    
    /**
     * Setup Phase: Executed once when the extension loads.
     * Restores cache from disk before any nodes are created.
     */
    async setup(app) {
        await LocalCache.restoreFromDisk();
    },
    
    /**
     * Node Definition Phase: Executed for every node type registered.
     * Modifies the "NeuradVisualLora" node specifically.
     */
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "NeuradVisualLora") {
            
            // --- ON NODE CREATED ---
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function() {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                this.setSize([400, 300]);
                
                // Add "Open Library" Button Widget
                this.addWidget("button", "Open Library", "Open", () => {
                    createFloatingPanel(this);
                });

                // Create Hidden Data Widget (Stores JSON for backend)
                let dataWidget = this.widgets.find(w => w.name === "lora_data");
                if (!dataWidget) {
                    dataWidget = this.addWidget("string", "lora_data", "[]", () => {}, { hidden: true });
                }

                // COMPLETE NEUTRALIZATION OF HIDDEN WIDGET
                // Ensures the widget takes up 0 space and ignores all interactions.
                
                // A. Force Size to Zero
                dataWidget.computeSize = function(width) { return [0, 0]; };

                // B. Override Draw (Return 0 height)
                dataWidget.draw = function(ctx, node, widgetWidth, widgetY, widgetHeight) { return 0; };

                // C. Override Mouse (Ignore clicks)
                dataWidget.mouse = function(event, pos, node) { return false; };

                // D. Hide DOM Element
                if (dataWidget.element) {
                    dataWidget.element.style.display = "none";
                    dataWidget.element.style.visibility = "hidden";
                    dataWidget.element.style.pointerEvents = "none";
                    if (document.activeElement === dataWidget.element) dataWidget.element.blur();
                }

                // E. Shield: Prevent getWidgetOnPos from detecting this widget
                const originalGetWidgetOnPos = this.getWidgetOnPos;
                this.getWidgetOnPos = function(x, y) {
                    const widget = originalGetWidgetOnPos ? originalGetWidgetOnPos.call(this, x, y) : null;
                    if (widget === dataWidget) return null;
                    return widget;
                };

                // F. Shield: Prevent onMouseDown from interacting with this widget
                const originalOnMouseDown = this.onMouseDown;
                this.onMouseDown = function(e) {
                    if (dataWidget.element && dataWidget.element.contains(e.target)) {
                        e.stopPropagation(); e.preventDefault(); return false;
                    }
                    if (originalOnMouseDown) return originalOnMouseDown.apply(this, arguments);
                };

                // Force Layout Update
                requestAnimationFrame(() => {
                    this.setSize([this.size[0], this.size[1]]); 
                    this.setDirtyCanvas(true, true);
                });
                
                // Initialize Properties
                if (!this.properties.activeLorasMap) this.properties.activeLorasMap = {};
                
                if (!this.properties.tabsConfig) {
                    this.properties.tabsConfig = {
                        activeTabId: "library",
                        tabs: [{ id: "library", name: "Library", locked: true, type: "dynamic", loras: [] }]
                    };
                }
                
                if (!this.properties.searchConfig) {
                    this.properties.searchConfig = {
                        query: "", excludeQuery: "", filters: [], lastActiveField: "positive"
                    };
                }

                this.properties._fullLoraCatalog = null; 

                // --- BACKGROUND RENDERING (List of Active LoRAs) ---
                this.onDrawBackground = function(ctx) {
                    if (this.flags && this.flags.collapsed) return;

                    const names = this.properties._cachedActiveDisplayNames || [];
                    ctx.save();
                    ctx.font = "12px sans-serif";
                    ctx.textAlign = "left";
                    ctx.textBaseline = "top";
                    ctx.fillStyle = "#aaa";

                    const startY = this.widgets.length > 0 
                        ? (this.widgets[this.widgets.length - 1].y + this.widgets[this.widgets.length - 1].height + 10) 
                        : 40;

                    const lineHeight = 16;
                    if (names.length === 0) {
                        ctx.fillText("No active LoRAs", 10, startY);
                    } else {
                        names.forEach((name, index) => {
                            ctx.fillText(name, 10, startY + (index * lineHeight));
                        });
                    }
                    ctx.restore();
                };
                
                // --- RESIZE HANDLER ---
                this._resizeTimer = null;
                const originalOnResize = this.onResize;
                this.onResize = function() {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    enforceMinSize(this, false);
                };

                return r;
            };

            // --- ON NODE REMOVED ---
            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function() {
                if (this.neuradPanel && document.body.contains(this.neuradPanel)) {
                    document.body.removeChild(this.neuradPanel);
                }
                if (onRemoved) onRemoved.apply(this, arguments);
            };
        }
    }
});