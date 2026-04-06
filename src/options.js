const DEFAULTS = {
	theme: 'system',
	accentColor: '#6068d2',
	disabledCategories: []
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Load saved settings
chrome.storage.sync.get(DEFAULTS, (settings) => {
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
	chrome.storage.sync.set({ [key]: value }, () => {
		showSaveStatus();
	});
}

function showSaveStatus() {
	const status = $('#save-status');
	status.textContent = 'Settings saved';
	status.classList.add('visible');
	setTimeout(() => status.classList.remove('visible'), 1500);
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
		save('accentColor', color);
	});
});

// Custom color picker
$('#custom-color').addEventListener('input', (e) => {
	const color = e.target.value;
	$$('.color-option').forEach(b => b.classList.remove('active'));
	document.documentElement.style.setProperty('--accent', color);
	save('accentColor', color);
});

// Category toggles
$$('.toggle-switch input').forEach(toggle => {
	toggle.addEventListener('change', () => {
		chrome.storage.sync.get({ disabledCategories: [] }, (settings) => {
			const cat = toggle.dataset.category;
			let disabled = settings.disabledCategories;
			if (toggle.checked) {
				disabled = disabled.filter(c => c !== cat);
			} else {
				if (!disabled.includes(cat)) disabled.push(cat);
			}
			save('disabledCategories', disabled);
		});
	});
});

// Change shortcut button
$('#change-shortcut').addEventListener('click', () => {
	chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
