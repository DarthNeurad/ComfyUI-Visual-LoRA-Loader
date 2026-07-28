// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
export const CONFIG = {
    // Dimensions
    CARD_WIDTH: 140,
    CARD_HEIGHT: 230,
    CARD_HEIGHT_PX: "230px",
    IMG_HEIGHT: 160,
    TAB_HEIGHT: 28,
    
    // Behavior
    STRENGTH_STEP: 0.05,
    CACHE_SAVE_DELAY_MS: 1000,
    IMAGE_CACHE_MAX_ITEMS: 800,
    
    // Colors (ComfyUI Native Palette)
    COLORS: {
        // --- Backgrounds ---
        bg_dark: '#222222',
        bg_panel: '#353535',
        bg_header: '#333333',
        bg_toggle: '#3b3b3b',
        bg_toggle_faded: '#4c4c4c',
        bg_card_inactive: '#444444',
        bg_card_active: '#5577bb',
        bg_card_hover: '#666666',
        bg_card_active_hover: '#7799dd',
		bg_button: '#666666',
		bg_button_hover: '#a1a1a1',
        bg_tab_active: '#353535',
        bg_tab_hover: '#2b2b2b',
		bg_close_hover: '#bb6666',
        
        // --- Borders & Separators ---
        border_default: '#666666',
        border_active: '#5577bb',
        border_moving_marker: '#2266ee',
        border_error: '#ff6b6b',
        border_negative: '#885555',
        separator_header: '#2c2c2c',
		border_bright_blue: '#4488ff',

        // --- Text ---
        text_main: '#dddddd',
        text_node_title: '#ffffff',
        text_field_title: '#999999',
        text_faded: '#6c6c6c',
		text_negative: '#bb6666',
        text_links: '#aaaaff',
        text_error: '#ffaaaa',

        // --- Accents & Status ---
        accent_blue_faded: '#8899bb', //button hover
        accent_blue_select: '#5577bb', //button 
        dot_off: '#888888',
        dot_off_dark: '#333333',
        
        // --- Scrollbars ---
        scroll_track: '#222222',
        scroll_thumb: '#666666',
        scroll_hover: '#999999'
    }
};

//${CONFIG.COLORS.}