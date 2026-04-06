const DEFAULTS = {
	theme: 'system',
	accentColor: '#6068d2',
	disabledCategories: []
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const ACCENT_SAVE_DEBOUNCE_MS = 150;

let currentSettings = { ...DEFAULTS };
let saveStatusTimer = 0;
let accentSaveTimer = 0;

// Load saved settings
chrome.storage.sync.get(DEFAULTS, (settings) => {
	currentSettings = { ...settings };
	applySettings(settings);
});

function applySettings(settings) {
	// Theme
	$$('.theme-option').forEach(btn => {
		btn.classList.toggle('active', btn.dataset.theme === settings.theme);
	});

	// Accent color
	$$('.color-option').forEach(btn => {
		btn.classList.toggle('active', btn.dataset.color === settings.accentColor);
	});
	$('#custom-color').value = settings.accentColor;

	// Apply accent to page
	document.documentElement.style.setProperty('--accent', settings.accentColor);

	// Category toggles
	$$('.toggle-switch input').forEach(toggle => {
		toggle.checked = !settings.disabledCategories.includes(toggle.dataset.category);
	});
}

function save(key, value) {
	currentSettings[key] = value;
	chrome.storage.sync.set({ [key]: value }, () => {
		showSaveStatus();
	});
}

function showSaveStatus() {
	const status = $('#save-status');
	status.textContent = 'Settings saved';
	status.classList.add('visible');
	if (saveStatusTimer) {
		window.clearTimeout(saveStatusTimer);
	}
	saveStatusTimer = window.setTimeout(() => status.classList.remove('visible'), 1500);
}

function queueAccentColorSave(color) {
	if (accentSaveTimer) {
		window.clearTimeout(accentSaveTimer);
	}
	accentSaveTimer = window.setTimeout(() => {
		save('accentColor', color);
	}, ACCENT_SAVE_DEBOUNCE_MS);
}

// Theme buttons
$$('.theme-option').forEach(btn => {
	btn.addEventListener('click', () => {
		$$('.theme-option').forEach(b => b.classList.remove('active'));
		btn.classList.add('active');
		save('theme', btn.dataset.theme);
	});
});

// Preset color buttons
$$('.color-option').forEach(btn => {
	btn.addEventListener('click', () => {
		$$('.color-option').forEach(b => b.classList.remove('active'));
		btn.classList.add('active');
		const color = btn.dataset.color;
		$('#custom-color').value = color;
		document.documentElement.style.setProperty('--accent', color);
		if (accentSaveTimer) {
			window.clearTimeout(accentSaveTimer);
			accentSaveTimer = 0;
		}
		save('accentColor', color);
	});
});

// Custom color picker
$('#custom-color').addEventListener('input', (e) => {
	const color = e.target.value;
	$$('.color-option').forEach(b => b.classList.remove('active'));
	document.documentElement.style.setProperty('--accent', color);
	queueAccentColorSave(color);
});

// Category toggles
$$('.toggle-switch input').forEach(toggle => {
	toggle.addEventListener('change', () => {
		const cat = toggle.dataset.category;
		let disabled = Array.isArray(currentSettings.disabledCategories)
			? [...currentSettings.disabledCategories]
			: [];
		if (toggle.checked) {
			disabled = disabled.filter(c => c !== cat);
		} else if (!disabled.includes(cat)) {
			disabled.push(cat);
		}
		save('disabledCategories', disabled);
	});
});

// Change shortcut button
$('#change-shortcut').addEventListener('click', () => {
	chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
