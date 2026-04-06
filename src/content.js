const omniRuntimeId = (() => {
	try { return chrome.runtime.id; }
	catch (e) { return "omni-no-runtime"; }
})();

// Prevent double injection for the same extension runtime, but allow reinjection
// after the extension is reloaded and the old content script becomes orphaned.
if (window.__omniInitialized && window.__omniRuntimeId === omniRuntimeId) { /* skip */ } else {
window.__omniInitialized = true;
window.__omniRuntimeId = omniRuntimeId;

// Detect extension context invalidation (orphaned content script after reload)
const extAlive = () => {
	try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
	catch (e) { return false; }
};

// Workaround to capture Esc key on certain sites
var isOpen = false;
document.addEventListener("keyup", (e) => {
	if (!e.isTrusted) return;
	if (!extAlive()) return;
	if (e.key == "Escape" && isOpen) {
		try { chrome.runtime.sendMessage({request:"close-omni"}); } catch (err) {}
	}
}, true);

// Helper functions
const $ = (selector, parent) => (parent || document).querySelector(selector);
const $$ = (selector, parent) => (parent || document).querySelectorAll(selector);

function htmlToElement(html) {
	const template = document.createElement('template');
	template.innerHTML = html.trim();
	return template.content.firstChild;
}

// Wait for DOM ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}

function init() {
	var actions = [];
	var filteredActions = null; // holds the filtered array when in filter mode
	var isFiltered = false;
	var omniVirtualList = null;
	var activeItemIndex = 0;
	var filterRequestId = 0;
	var isOpening = false;
	var activeFilterRequest = 0;
	var searchTimer = 0;
	var focusTimer = 0;
	var toastTimer = 0;
	const FILTER_DEBOUNCE_MS = 80;
	const VIRTUALIZE_THRESHOLD = 40;
	const fallbackIconUrl = chrome.runtime.getURL("/assets/globe.svg");

	// Load settings then init UI
	if (!extAlive()) return;
	try {
		chrome.storage.sync.get({
			theme: 'system',
			accentColor: '#6068d2',
			disabledCategories: []
		}, (settings) => {
			initUI(settings);
		});
	} catch (e) { return; }

	function escapeHtml(value) {
		return String(value == null ? "" : value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	function getKeysMarkup(action) {
		if (!action.keycheck || !Array.isArray(action.keys) || !action.keys.length) return "";
		return "<div class='omni-keys'>" + action.keys.map((key) => (
			"<span class='omni-shortcut'>" + escapeHtml(key) + "</span>"
		)).join("") + "</div>";
	}

		function getIconMarkup(action) {
			if (action.emoji) {
				return "<span class='omni-emoji-action'>" + escapeHtml(action.emojiChar) + "</span>";
			}

			const iconUrl = escapeHtml(action.favIconUrl || fallbackIconUrl);
			return "<img src='" + iconUrl + "' alt='' class='omni-icon' loading='lazy' decoding='async'>";
		}

	function buildActionMarkup(action, index, description) {
		const urlAttr = action.url ? " data-url='" + escapeHtml(action.url) + "'" : "";
		return (
			"<div class='omni-item' data-index='" + index + "' data-type='" + escapeHtml(action.type) + "'" + urlAttr + ">" +
				getIconMarkup(action) +
				"<div class='omni-item-details'>" +
					"<div class='omni-item-name'>" + escapeHtml(action.title) + "</div>" +
					"<div class='omni-item-desc'>" + escapeHtml(description || "") + "</div>" +
				"</div>" +
				getKeysMarkup(action) +
				"<div class='omni-select'>Select <span class='omni-shortcut'>\u23CE</span></div>" +
			"</div>"
		);
	}

	function destroyVirtualList() {
		if (omniVirtualList && typeof omniVirtualList.destroy === "function") {
			omniVirtualList.destroy();
		}
		omniVirtualList = null;
	}

		function clearTimer(timerId) {
		if (timerId) {
			window.clearTimeout(timerId);
		}
			return 0;
		}

		function bindIconFallback(img) {
			if (!img || img.dataset.omniIconBound === "1") return;
			img.dataset.omniIconBound = "1";
			img.addEventListener("error", () => {
				if (img.dataset.omniIconFallbackApplied === "1") return;
				img.dataset.omniIconFallbackApplied = "1";
				img.src = fallbackIconUrl;
			});
		}

		function bindRenderedIconFallbacks(scope) {
			(scope || document).querySelectorAll(".omni-icon").forEach(bindIconFallback);
		}

	function getOmniInput() {
		return $("#omni-extension input");
	}

	function getOmniRoot() {
		return $("#omni-extension");
	}

	function getOmniList() {
		return $("#omni-extension #omni-list");
	}

	function updateResultsLabel(count) {
		const results = $(".omni-extension #omni-results");
		if (results) results.textContent = count + " results";
	}

		function syncActiveItem() {
			const items = Array.from($$("#omni-extension #omni-list .omni-item"));
			let visibleCount = 0;
		let firstVisible = null;
		let activeVisible = null;

		items.forEach((item) => {
			if (item.classList.contains("omni-hidden")) return;
			visibleCount += 1;
			if (!firstVisible) firstVisible = item;
			if (item.classList.contains("omni-item-active")) activeVisible = item;
		});

		if (!activeVisible) {
			const active = $(".omni-item-active");
			if (active) active.classList.remove("omni-item-active");
			if (firstVisible) {
				firstVisible.classList.add("omni-item-active");
				activeItemIndex = parseInt(firstVisible.getAttribute("data-index"), 10) || 0;
			}
		} else {
			activeItemIndex = parseInt(activeVisible.getAttribute("data-index"), 10) || 0;
		}

			updateResultsLabel(visibleCount);
		}

	function keepItemInView(target) {
		const list = getOmniList();
		if (!list || !target) return;
		const tTop = target.offsetTop;
		const tBot = tTop + target.offsetHeight;
		if (tTop < list.scrollTop) {
			list.scrollTop = tTop;
		} else if (tBot > list.scrollTop + list.clientHeight) {
			list.scrollTop = tBot - list.clientHeight;
		}
	}

	function setActiveItemByIndex(index, shouldScroll) {
		const active = $(".omni-item-active");
		if (active) active.classList.remove("omni-item-active");
		activeItemIndex = index;

		let target = $(`.omni-item[data-index='${index}']`);
		if (!target && omniVirtualList) {
			omniVirtualList.scrollToIndex(index);
			window.requestAnimationFrame(() => {
				const rendered = $(`.omni-item[data-index='${index}']`);
				if (!rendered) return;
				rendered.classList.add("omni-item-active");
				if (shouldScroll !== false) keepItemInView(rendered);
			});
			return;
		}

		if (target) {
			target.classList.add("omni-item-active");
			if (shouldScroll !== false) keepItemInView(target);
		}
	}

	function setOmniVisible(visible) {
		const omniExt = getOmniRoot();
		if (omniExt) omniExt.classList.toggle("omni-closing", !visible);
	}

	function cancelPendingOpen() {
		filterRequestId += 1;
		isOpening = false;
		focusTimer = clearTimer(focusTimer);
	}

	function scheduleFocus(openRequestId) {
		focusTimer = clearTimer(focusTimer);
		focusTimer = window.setTimeout(() => {
			if (!isOpen || isOpening || filterRequestId !== openRequestId) return;
			const input = getOmniInput();
			if (!input) return;
			input.focus();
			focusLock.on(input);
			input.focus();
		}, 100);
	}

		function initUI(settings) {
			if (!extAlive()) return;
			// Append the omni into the current page
			fetch(chrome.runtime.getURL('/content.html'))
				.then(r => r.text())
				.then(data => {
					const staleOmni = $("#omni-extension");
					const staleToast = $("#omni-extension-toast");
					if (staleOmni) staleOmni.remove();
					if (staleToast) staleToast.remove();

					// Append both elements (omni-extension and toast)
					const tempDiv = document.createElement('div');
					tempDiv.innerHTML = data;
					Array.from(tempDiv.children).forEach(child => document.body.appendChild(child));

					// Get checkmark image for toast
					const toastImg = $("#omni-extension-toast img");
					if (toastImg) toastImg.setAttribute("src", chrome.runtime.getURL("assets/check.svg"));

					// Apply theme
					applyTheme(settings.theme);
					applyAccentColor(settings.accentColor);

					// Bind events
					document.addEventListener("click", (e) => {
						if (!isOpen) return;
						// Ignore synthetic clicks dispatched by the host page
						if (!e.isTrusted) return;
						if (!extAlive()) return;

						const item = e.target.closest(".omni-item");
						if (item) {
							if (!item.classList.contains("omni-item-active")) {
								hoverItem.call(item);
							}
							handleAction(e);
							return;
						}

						// Strict overlay match — close only when clicking the overlay itself
						if (e.target.id === "omni-overlay") closeOmni();
					}, true);

					document.addEventListener("mouseover", (e) => {
						if (!isOpen) return;
						const item = e.target.closest(".omni-extension .omni-item:not(.omni-item-active)");
						if (item) hoverItem.call(item);
					});

				const omniInput = getOmniInput();
				if (omniInput) {
					omniInput.addEventListener("keyup", search);
				}

				if (isNewTabPage()) {
					openOmni();
				}
			}).catch(() => {});

		// Listen for settings changes
		try {
			chrome.storage.onChanged.addListener((changes, namespace) => {
				if (namespace === 'sync') {
					if (changes.theme) applyTheme(changes.theme.newValue);
					if (changes.accentColor) applyAccentColor(changes.accentColor.newValue);
				}
			});
		} catch (e) {}
	}

	function applyTheme(theme) {
		const omniExt = $("#omni-extension");
		const toast = $("#omni-extension-toast");
		const targets = [omniExt, toast].filter(Boolean);

		targets.forEach(el => {
			el.classList.remove("omni-theme-dark", "omni-theme-light", "omni-theme-system");
			el.classList.add(`omni-theme-${theme}`);
		});
	}

	function applyAccentColor(color) {
		const omniExt = $("#omni-extension");
		const toast = $("#omni-extension-toast");
		[omniExt, toast].filter(Boolean).forEach(el => {
			el.style.setProperty('--accent', color);
			// Generate a darker hover variant
			el.style.setProperty('--accent-hover', darkenColor(color, 20));
		});
	}

	function darkenColor(hex, percent) {
		const num = parseInt(hex.replace('#', ''), 16);
		const amt = Math.round(2.55 * percent);
		const R = Math.max((num >> 16) - amt, 0);
		const G = Math.max((num >> 8 & 0x00FF) - amt, 0);
		const B = Math.max((num & 0x0000FF) - amt, 0);
		return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
	}

	// Add actions to the omni
		function populateOmni() {
		filteredActions = null;
		isFiltered = false;
		activeItemIndex = 0;
		destroyVirtualList();
		const omniList = getOmniList();
		if (!omniList) return;
			omniList.innerHTML = actions.map((action, index) => (
				buildActionMarkup(action, index, action.desc)
			)).join("");
			bindRenderedIconFallbacks(omniList);
			syncActiveItem();
		}

	// Add filtered actions to the omni
	function populateOmniFilter(filterArr) {
		isFiltered = true;
		filteredActions = filterArr;
		activeItemIndex = 0;
		const omniList = getOmniList();
		if (!omniList) return;
		destroyVirtualList();
		omniList.innerHTML = "";

			const renderRow = (index) => {
				const action = filteredActions[index];
				const row = htmlToElement(buildActionMarkup(action, index, action.url || action.desc || ""));
				if (index === activeItemIndex) row.classList.add("omni-item-active");
				row.nodeIndex = index;
				bindRenderedIconFallbacks(row);
				return row;
			};

		if (!filteredActions.length) {
			updateResultsLabel(0);
			return;
		}

		if (filteredActions.length <= VIRTUALIZE_THRESHOLD) {
			omniList.innerHTML = filteredActions.map((action, index) => (
				buildActionMarkup(action, index, action.url || action.desc || "")
			)).join("");
			bindRenderedIconFallbacks(omniList);
			setActiveItemByIndex(0, false);
			updateResultsLabel(filteredActions.length);
			return;
		}

		omniVirtualList = new VirtualizedList.default(omniList, {
				height: 400,
				rowHeight: 60,
				rowCount: filteredActions.length,
				renderRow,
				onMount: () => {
					updateResultsLabel(filteredActions.length);
				},
			});
	}

		// Safe wrapper for chrome.runtime.sendMessage — returns false if context invalid
		function safeSend(msg, cb) {
			if (!extAlive()) return false;
			try {
				if (cb) {
					chrome.runtime.sendMessage(msg, (response) => {
						if (chrome.runtime.lastError) {
							cb();
							return;
						}
						cb(response);
					});
				}
				else chrome.runtime.sendMessage(msg);
				return true;
			} catch (e) { return false; }
	}

	// Helpers to lock/unlock host-page scroll while popup is open.
	// This prevents scrollbar toggling → viewport width shift → layout loop.
	let savedOverflow = '';
	function lockScroll() {
		savedOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
	}
	function unlockScroll() {
		document.body.style.overflow = savedOverflow;
	}

		// Open the omni
		function openOmni() {
			if (isOpen || isOpening) return;
			if (document.hidden && !isNewTabPage()) return;
			const openRequestId = ++filterRequestId;
			isOpening = true;
			if (!safeSend({request:"get-actions"}, (response) => {
				if (filterRequestId !== openRequestId) return;
				isOpening = false;
				if (!response || (document.hidden && !isNewTabPage())) return;
				isOpen = true;
				actions = Array.isArray(response.actions) ? response.actions : [];
				const input = getOmniInput();
				if (input) input.value = "";
				populateOmni();
				lockScroll();
				setOmniVisible(true);
				scheduleFocus(openRequestId);
			})) {
				isOpening = false;
				return;
			}
		}

		// Close the omni
		function closeOmni() {
			if (!isOpen && !isOpening) return;
			cancelPendingOpen();
			searchTimer = clearTimer(searchTimer);
			activeFilterRequest += 1;

			const input = getOmniInput();
			if (input) try { focusLock.off(input); } catch (e) {}
			unlockScroll();

			if (!extAlive()) {
				isOpen = false;
				setOmniVisible(false);
				return;
			}

			if (window.location.href === `chrome-extension://${chrome.runtime.id}/newtab.html`) {
				isOpen = false;
				setOmniVisible(false);
				try { chrome.runtime.sendMessage({request:"restore-new-tab"}); } catch (e) {}
			} else {
				isOpen = false;
				setOmniVisible(false);
			}
		}

		function closeOmniForAction() {
			if (!isOpen && !isOpening) return;
			cancelPendingOpen();
			searchTimer = clearTimer(searchTimer);
			activeFilterRequest += 1;
			isOpen = false;

			const input = getOmniInput();
			if (input) try { focusLock.off(input); } catch (e) {}
			unlockScroll();
			setOmniVisible(false);
		}

		// Force-close without messaging the background (for tab visibility loss)
		function forceCloseOmni() {
			cancelPendingOpen();
			searchTimer = clearTimer(searchTimer);
			activeFilterRequest += 1;
			isOpen = false;

			const input = getOmniInput();
			if (input) try { focusLock.off(input); } catch (e) {}
			unlockScroll();
			setOmniVisible(false);
		}

	// The newtab page is special — popup is the entire page, don't auto-close it
	const isNewTabPage = () => {
		try {
			return window.location.href === `chrome-extension://${chrome.runtime.id}/newtab.html`;
		} catch (e) { return false; }
	};

		// Close popup when the tab is hidden (tab switch, window hide, minimize)
		// NOTE: intentionally NOT listening to window.blur — it fires spuriously on
		// pages with iframes or resize loops and would cause a close/open oscillation.
		document.addEventListener("visibilitychange", () => {
			if (document.hidden && (isOpen || isOpening) && !isNewTabPage()) forceCloseOmni();
		});

	// Hover over an action in the omni
	function hoverItem() {
		const active = $(".omni-item-active");
		if (active) active.classList.remove("omni-item-active");
		this.classList.add("omni-item-active");
		activeItemIndex = parseInt(this.getAttribute("data-index"), 10) || 0;
	}

	// Show a toast when an action has been performed
	function showToast(action) {
		const toastSpan = $("#omni-extension-toast span");
		if (toastSpan) toastSpan.textContent = '"' + action.title + '" has been successfully performed';
		const toast = $("#omni-extension-toast");
		if (toast) toast.classList.add("omni-show-toast");
		toastTimer = clearTimer(toastTimer);
		toastTimer = window.setTimeout(() => {
			const showToast = $(".omni-show-toast");
			if (showToast) showToast.classList.remove("omni-show-toast");
		}, 3000);
	}

	function matchesAction(action, query) {
		return [
			action && action.title,
			action && action.desc,
			action && action.url,
			action && action.pendingUrl
		].some((field) => String(field || "").toLowerCase().includes(query));
	}

	// Search through open tabs only
	function search(e) {
		if (!isOpen) return;
		if (e.keyCode == 37 || e.keyCode == 38 || e.keyCode == 39 || e.keyCode == 40 || e.keyCode == 13) {
			return;
		}
		const value = this.value.trim().toLowerCase();

		searchTimer = clearTimer(searchTimer);
		if (!value) {
			activeFilterRequest += 1;
			if (isFiltered) populateOmni();
			else syncActiveItem();
			return;
		}

		const requestId = ++activeFilterRequest;
		searchTimer = window.setTimeout(() => {
			if (requestId !== activeFilterRequest || !isOpen) return;
			populateOmniFilter(actions.filter((action) => matchesAction(action, value)));
		}, FILTER_DEBOUNCE_MS);
	}

	// Handle actions from the omni
	function handleAction() {
			const activeEl = $(".omni-item-active");
			if (!activeEl) return;

			const idx = parseInt(activeEl.getAttribute("data-index"));
			const sourceArray = isFiltered && filteredActions ? filteredActions : actions;
			var action = sourceArray[idx];
			if (!action) return;

			closeOmniForAction();
			if (action.action === "toggle-mute") {
				safeSend({request:"toggle-mute"});
			} else if (action.action === "switch-tab") {
				safeSend({request:"switch-tab", tab:action});
			}
	}

	function moveActive(direction) {
		const active = $(".omni-item-active");
		const sourceArray = isFiltered && filteredActions ? filteredActions : actions;
		if (omniVirtualList) {
			const delta = direction === 'up' ? -1 : 1;
			const nextIndex = Math.max(0, Math.min(activeItemIndex + delta, sourceArray.length - 1));
			if (nextIndex !== activeItemIndex) setActiveItemByIndex(nextIndex);
			return;
		}
		if (!active) return;
		let target = direction === 'up' ? active.previousElementSibling : active.nextElementSibling;
		while (target && target.classList.contains('omni-hidden')) {
			target = direction === 'up' ? target.previousElementSibling : target.nextElementSibling;
		}
		if (target) {
			active.classList.remove("omni-item-active");
			target.classList.add("omni-item-active");
			activeItemIndex = parseInt(target.getAttribute("data-index"), 10) || 0;
			keepItemInView(target);
		}
	}

	document.addEventListener("keydown", (e) => {
		if (!e.isTrusted) return;
		if (!extAlive()) return;
		if (!isOpen) return;

		// Ignore OS key-repeat events to prevent multi-step jumps
		if (e.repeat) {
			if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") {
				e.preventDefault();
				e.stopImmediatePropagation();
			}
			return;
		}

		switch (e.key) {
			case "ArrowUp":
				e.preventDefault();
				e.stopImmediatePropagation();
				moveActive('up');
				break;
			case "ArrowDown":
				e.preventDefault();
				e.stopImmediatePropagation();
				moveActive('down');
				break;
			case "Enter":
				e.preventDefault();
				e.stopImmediatePropagation();
				handleAction(e);
				break;
			case "Escape":
				e.preventDefault();
				closeOmni();
				break;
		}
	}, true);

	// Receive messages from background
	try {
		chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
			if (!extAlive()) return;
			if (message.request == "open-omni") {
				if (isOpen || isOpening) {
					closeOmni();
				} else {
					openOmni();
				}
			} else if (message.request == "close-omni") {
				closeOmni();
			}
		});
	} catch (e) {}
}

} // end of double-injection guard
