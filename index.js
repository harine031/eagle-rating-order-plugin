(() => {
  "use strict";

  const list = document.querySelector("#list");
  const status = document.querySelector("#status");
  const previewOverlay = document.querySelector("#previewOverlay");
  const previewImage = document.querySelector("#previewImage");
  const previewName = document.querySelector("#previewName");
  const previewCounter = document.querySelector("#previewCounter");
  const state = { folder: null, allItems: [], items: [], storageKey: "" };
  let draggedIds = new Set();
  let dropPosition = "before";
  let dropIndicator = null;
  let selectedId = null;
  const selectedIds = new Set();
  const tileSizeInput = document.querySelector("#tileSize");
  const tileSizeValue = document.querySelector("#tileSizeValue");
  const renameProgressContainer = document.querySelector("#renameProgressContainer");
  const renameProgress = document.querySelector("#renameProgress");
  const renameProgressText = document.querySelector("#renameProgressText");
  const renameBaseNameInput = document.querySelector("#renameBaseName");
  const removePngMetadataOption = document.querySelector("#removePngMetadataOption");
  let previewZoom = 1;
  let previewRotation = 0;
  let slideshowTimer = null;
  let renameInProgress = false;

  function applyTileSize(value) {
    const size = Math.max(100, Math.min(800, Number(value) || 180));
    list.style.setProperty("--tile-size", `${size}px`);
    tileSizeInput.value = String(size);
    tileSizeValue.value = `${size}px`;
    tileSizeValue.textContent = `${size}px`;
    if (state.storageKey) localStorage.setItem(`${state.storageKey}:tile-size`, String(size));
  }

  const setStatus = (message) => { status.textContent = message; };
  const getRating = (item) => Number(item.star || 0);

  function setRenameControlsDisabled(disabled) {
    document.querySelector("#renameSequential").disabled = disabled;
    document.querySelector("#renameSelected").disabled = disabled;
    document.querySelector("#renameDigits").disabled = disabled;
    renameBaseNameInput.disabled = disabled;
    removePngMetadataOption.disabled = disabled;
  }

  function updateRenameProgress(current, total, message) {
    renameProgressContainer.hidden = false;
    renameProgress.max = Math.max(1, total);
    renameProgress.value = Math.max(0, Math.min(current, total));
    renameProgressText.textContent = message;
  }

  async function nextPaint() {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  async function withTimeout(promise, milliseconds, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), milliseconds);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getStorageKey(folder) {
    let library = {};
    try { library = await eagle.library.info(); } catch (_) { /* active library */ }
    return `rating-order:${library.id || library.path || "active"}:${folder.id}`;
  }

  function readOrder() {
    try { return JSON.parse(localStorage.getItem(state.storageKey) || "[]"); }
    catch (_) { return []; }
  }

  function writeOrder() {
    const ids = state.allItems.map((item) => item.id);
    localStorage.setItem(state.storageKey, JSON.stringify(ids));
    localStorage.setItem(`${state.storageKey}:sort-mode`, document.querySelector("#sortSelect").value);
    setStatus(`順番を保存しました（${ids.length}件）`);
  }

  function readSortMode() {
    const savedMode = localStorage.getItem(`${state.storageKey}:sort-mode`);
    const option = [...document.querySelector("#sortSelect").options]
      .find((candidate) => candidate.value === savedMode);
    return option ? option.value : null;
  }

  function updateRatingButtons() {
    const item = state.items.find((value) => value.id === selectedId);
    const currentRating = item ? getRating(item) : null;

    document.querySelectorAll("[data-rating]").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.rating) === currentRating);
    });
  }

  function getSelectedItems() {
    return state.allItems.filter((item) => selectedIds.has(item.id));
  }

  function selectItem(item, additive) {
    if (!additive) selectedIds.clear();
    if (additive && selectedIds.has(item.id)) selectedIds.delete(item.id);
    else selectedIds.add(item.id);
    selectedId = selectedIds.has(item.id) ? item.id : (selectedIds.values().next().value || null);
    render();
    updateRatingButtons();
    setStatus(`${selectedIds.size}件選択中（Ctrl＋クリックで追加、Deleteでゴミ箱）`);
  }

  function applyRatingFilter() {
    updateRatingFilterCounts();
    const filter = document.querySelector("#ratingFilter").value;
    state.items = filter === "all"
      ? [...state.allItems]
      : state.allItems.filter((item) => getRating(item) === Number(filter));
  }

  function updateRatingFilterCounts() {
    const counts = [0, 0, 0, 0, 0, 0];
    for (const item of state.allItems) counts[Math.max(0, Math.min(5, getRating(item)))] += 1;
    const options = document.querySelectorAll("#ratingFilter option");
    options.forEach((option) => {
      if (option.value === "all") option.textContent = `すべて（${state.allItems.length}件）`;
      else if (option.value === "0") option.textContent = `評価なし（${counts[0]}件）`;
      else option.textContent = `★${option.value}（${counts[Number(option.value)]}件）`;
    });
  }

  async function saveRatingToEagle(item, value) {
    const response = await fetch("http://localhost:41595/api/item/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, star: value })
    });
    if (!response.ok) throw new Error(`Eagle評価更新に失敗しました（HTTP ${response.status}）`);
    const result = await response.json();
    if (result.status && result.status !== "success") {
      throw new Error(result.message || "Eagle評価更新に失敗しました");
    }
    const refreshed = await eagle.item.getById(item.id);
    return refreshed || item;
  }

  async function setSelectedRating(value) {
    const targets = getSelectedItems();
    if (!targets.length) {
      setStatus("画像をクリックして選択してください");
      return;
    }

    for (const item of targets) {
      const refreshed = await saveRatingToEagle(item, value);
      const index = state.allItems.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) state.allItems[index] = refreshed;
    }
    updateRatingButtons();

    const selectedSort = document.querySelector("#sortSelect").value;
    if (selectedSort !== "manual") sortItems(selectedSort);
    applyRatingFilter();
    render();
    writeOrder();
    setStatus(`${targets.length}件の評価を ${value === 0 ? "なし" : `★${value}`} に変更しました`);
  }

  function hideDropIndicator() {
    if (dropIndicator) dropIndicator.remove();
    dropIndicator = null;
  }

  function showDropIndicator(card, position) {
    hideDropIndicator();

    dropIndicator = document.createElement("div");
    dropIndicator.id = "dropIndicator";

    const listRect = list.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const gap = 6;
    const x = position === "before"
      ? cardRect.left - listRect.left - gap
      : cardRect.right - listRect.left + gap;

    dropIndicator.style.left = `${x}px`;
    dropIndicator.style.top = `${cardRect.top - listRect.top}px`;
    dropIndicator.style.height = `${cardRect.height}px`;
    list.appendChild(dropIndicator);
  }

  function getDraggedItems() {
    return state.items.filter((item) => draggedIds.has(item.id));
  }

  function clearDragState() {
    draggedIds.clear();
    list.querySelectorAll(".dragging").forEach((card) => card.classList.remove("dragging"));
    hideDropIndicator();
  }

  function saveVisibleOrder() {
    const visibleIds = new Set(state.items.map((item) => item.id));
    const reordered = [];
    let visibleIndex = 0;

    for (const item of state.allItems) {
      reordered.push(visibleIds.has(item.id) ? state.items[visibleIndex++] : item);
    }
    state.allItems = reordered;
  }

  function sortItems(mode) {
    if (mode === "manual") return;

    if (mode === "random") {
      state.allItems.sort(() => Math.random() - 0.5);
      return;
    }

    const [field, direction] = mode.split("-");
    const factor = direction === "asc" ? 1 : -1;

    state.allItems.sort((a, b) => {
      let left;
      let right;

      if (field === "rating") {
        left = getRating(a);
        right = getRating(b);
      } else if (field === "name") {
        left = String(a.name || "");
        right = String(b.name || "");
      } else if (field === "imported") {
        left = Number(a.importedAt || 0);
        right = Number(b.importedAt || 0);
      } else if (field === "modified") {
        left = Number(a.modifiedAt || 0);
        right = Number(b.modifiedAt || 0);
      } else if (field === "size") {
        left = Number(a.size || 0);
        right = Number(b.size || 0);
      } else if (field === "resolution") {
        left = Number(a.width || 0) * Number(a.height || 0);
        right = Number(b.width || 0) * Number(b.height || 0);
      } else if (field === "ext") {
        left = String(a.ext || "");
        right = String(b.ext || "");
      }

      if (left === right) return String(a.id).localeCompare(String(b.id));
      if (typeof left === "string") return left.localeCompare(right, "ja") * factor;
      return (left - right) * factor;
    });
  }

  function applySelectedSort() {
    sortItems(document.querySelector("#sortSelect").value);
    applyRatingFilter();
    render();
    writeOrder();
    setStatus("並び替えを適用しました");
  }

  function mergeSavedOrder(items, savedIds) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const saved = savedIds.map((id) => byId.get(id)).filter(Boolean);
    const savedSet = new Set(saved.map((item) => item.id));
    const newItems = items
      .filter((item) => !savedSet.has(item.id))
      .sort((a, b) => getRating(b) - getRating(a));
    return [...saved, ...newItems];
  }

  function isPngItem(item) {
    return String(item.ext || "").replace(/^\./, "").toLowerCase() === "png";
  }

  function stripPngMetadata(buffer) {
    const BufferApi = require("buffer").Buffer;
    const bytes = BufferApi.from(buffer);
    const signature = BufferApi.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
      throw new Error("PNGファイルとして読み込めませんでした");
    }

    const metadataChunks = new Set(["tEXt", "zTXt", "iTXt", "eXIf"]);
    const chunks = [bytes.subarray(0, signature.length)];
    let offset = signature.length;
    let removed = false;

    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) throw new Error("PNGチャンクが壊れています");
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) throw new Error("PNGチャンクが壊れています");
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (metadataChunks.has(type)) removed = true;
      else chunks.push(bytes.subarray(offset, end));
      offset = end;
      if (type === "IEND") break;
    }

    if (offset !== bytes.length) throw new Error("PNGの終端を確認できませんでした");
    return { buffer: BufferApi.concat(chunks), removed };
  }

  async function removePngMetadata(item) {
    if (!isPngItem(item)) return false;
    if (!item.filePath || typeof item.replaceFile !== "function") {
      throw new Error(`${item.name || "PNG画像"}の元ファイルを差し替えられません`);
    }

    const fs = require("fs").promises;
    const path = require("path");
    const sourcePath = item.filePath;
    const source = await fs.readFile(sourcePath);
    const result = stripPngMetadata(source);
    if (!result.removed) return false;

    const tempPath = path.join(
      eagle.os.tmpdir(),
      `eagle-rating-order-${item.id}-${Date.now()}.png`
    );
    let replacePromise = null;
    try {
      await fs.writeFile(tempPath, result.buffer);
      replacePromise = Promise.resolve(item.replaceFile(tempPath));
      replacePromise.finally(() => fs.rm(tempPath, { force: true })).catch(() => {});
      await withTimeout(
        replacePromise,
        60000,
        `${item.name || "PNG画像"}のPNG情報削除が60秒以内に完了しませんでした`
      );
      const replacedFile = await fs.readFile(sourcePath);
      if (stripPngMetadata(replacedFile).removed) {
        throw new Error("PNGファイルの差し替え後も埋め込み情報が残っています");
      }
      return true;
    } catch (error) {
      if (!replacePromise) await fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  function render() {
    list.replaceChildren();
    if (!state.items.length) {
      list.innerHTML = '<div class="empty">画像がありません</div>';
      return;
    }

    for (const item of state.items) {
      const card = document.createElement("article");
      card.className = "item";
      card.dataset.id = item.id;
      card.draggable = true;
      if (item.id === selectedId) card.classList.add("selected");
      if (selectedIds.has(item.id)) card.classList.add("multi-selected");

      const image = document.createElement("img");
      image.src = item.thumbnailURL || item.thumbnailPath || "";
      image.alt = item.name || "";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = item.name || "(名称なし)";

      const rating = document.createElement("div");
      rating.className = "rating";
      rating.textContent = `★ ${getRating(item)}`;

      card.append(image, name, rating);
      card.addEventListener("click", (event) => {
        selectItem(item, event.ctrlKey || event.metaKey);
      });
      card.addEventListener("dblclick", () => {
        selectedIds.clear();
        selectedIds.add(item.id);
        selectedId = item.id;
        showPreview();
      });
      card.addEventListener("dragstart", (event) => {
        if (!selectedIds.has(item.id)) {
          selectedIds.clear();
          selectedIds.add(item.id);
          selectedId = item.id;
          updateRatingButtons();
        }

        draggedIds = new Set(state.items
          .filter((value) => selectedIds.has(value.id))
          .map((value) => value.id));
        list.querySelectorAll(".item").forEach((value) => {
          value.classList.toggle("dragging", draggedIds.has(value.dataset.id));
        });
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.id);
      });
      card.addEventListener("dragend", () => {
        clearDragState();
      });
      card.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (!draggedIds.size || draggedIds.has(item.id)) return;

        const rect = card.getBoundingClientRect();
        dropPosition = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
        showDropIndicator(card, dropPosition);
      });
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        if (!draggedIds.size || draggedIds.has(item.id)) return;

        const dragged = getDraggedItems();
        const remainingItems = state.items.filter((value) => !draggedIds.has(value.id));
        let targetIndex = remainingItems.findIndex((value) => value.id === item.id);
        if (dropPosition === "after") targetIndex += 1;
        remainingItems.splice(targetIndex, 0, ...dragged);
        state.items = remainingItems;
        saveVisibleOrder();
        clearDragState();
        render();
        writeOrder();
      });
      list.appendChild(card);
    }
  }

  async function loadItems() {
    try {
      setStatus("読み込み中…");
      const folders = await eagle.folder.getSelected();
      if (!folders.length) throw new Error("Eagleでフォルダを選択してください");

      state.folder = folders[0];
      state.storageKey = await getStorageKey(state.folder);
      applyTileSize(localStorage.getItem(`${state.storageKey}:tile-size`) || tileSizeInput.value);
      renameBaseNameInput.value = localStorage.getItem(`${state.storageKey}:rename-base-name`) || "";
      const items = await eagle.item.get({ folders: [state.folder.id] });
      const savedIds = readOrder();
      const savedSortMode = readSortMode();
      const sortMode = savedSortMode || (savedIds.length ? "manual" : "rating-desc");
      document.querySelector("#sortSelect").value = sortMode;
      state.allItems = sortMode === "manual" ? mergeSavedOrder(items, savedIds) : [...items];
      sortItems(sortMode);
      applyRatingFilter();
      render();
      setStatus(`${state.folder.name}：${state.items.length}/${state.allItems.length}件`);
    } catch (error) {
      list.replaceChildren();
      setStatus(error.message || "読み込みに失敗しました");
    }
  }

  function showPreview() {
    const item = state.items.find((value) => value.id === selectedId);
    if (!item) {
      setStatus("画像をクリックして選択してください");
      return;
    }

    previewImage.src = item.fileURL || item.filePath || item.thumbnailURL || item.thumbnailPath || "";
    previewImage.alt = item.name || "";
    previewName.textContent = item.name || "";
    const index = state.items.findIndex((value) => value.id === selectedId);
    previewCounter.textContent = `${index + 1} / ${state.items.length}`;
    previewImage.style.transform = `scale(${previewZoom}) rotate(${previewRotation}deg)`;
    previewOverlay.hidden = false;
  }

  function movePreview(step) {
    if (previewOverlay.hidden || !state.items.length) return;
    const currentIndex = state.items.findIndex((value) => value.id === selectedId);
    const nextIndex = (currentIndex + step + state.items.length) % state.items.length;
    selectedId = state.items[nextIndex].id;
    showPreview();
    render();
  }

  function hidePreview() {
    stopSlideshow();
    previewOverlay.hidden = true;
    previewImage.src = "";
    previewCounter.textContent = "";
  }

  async function openInEagle() {
    const item = state.allItems.find((value) => value.id === selectedId);
    if (item) await item.open();
  }

  function adjustPreviewZoom(amount) {
    previewZoom = Math.max(.25, Math.min(4, previewZoom + amount));
    showPreview();
  }

  function resetPreviewTransform() {
    previewZoom = 1;
    previewRotation = 0;
    showPreview();
  }

  function rotatePreview() {
    previewRotation = (previewRotation + 90) % 360;
    showPreview();
  }

  function stopSlideshow() {
    if (slideshowTimer) clearInterval(slideshowTimer);
    slideshowTimer = null;
    document.querySelector("#previewSlideshow").textContent = "▶";
  }

  function toggleSlideshow() {
    if (slideshowTimer) {
      stopSlideshow();
      return;
    }
    if (state.items.length < 2) return;
    slideshowTimer = setInterval(() => movePreview(1), 2500);
    document.querySelector("#previewSlideshow").textContent = "Ⅱ";
  }

  async function renameItems(targets, label) {
    if (renameInProgress) {
      setStatus("別のリネーム処理が進行中です");
      return;
    }
    if (!targets.length) {
      setStatus("画像を選択してください");
      return;
    }
    const digits = Math.max(1, Math.min(8, Number(document.querySelector("#renameDigits").value) || 3));
    const requestedBaseName = renameBaseNameInput.value.trim();
    const prefixPattern = /^\d{1,8}[_\-\s]/;
    const removeMetadata = removePngMetadataOption.checked;
    const pngCount = targets.filter(isPngItem).length;
    const metadataMessage = removeMetadata && pngCount
      ? `\nPNG ${pngCount}件の埋め込み情報も削除します（時間がかかる場合があります）。`
      : "\nPNGの埋め込み情報は削除しません。";
    if (!window.confirm(`${targets.length}件を${label}で連番リネームします。${metadataMessage}\n実行しますか？`)) return;

    renameInProgress = true;
    setRenameControlsDisabled(true);
    setStatus(`リネーム中… 0/${targets.length}`);
    updateRenameProgress(0, targets.length, `0 / ${targets.length}`);
    let cleanedPngCount = 0;
    let completedCount = 0;
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const item = targets[index];
        const oldName = String(item.name || "").replace(prefixPattern, "");
        const number = String(index + 1).padStart(digits, "0");
        const displayName = item.name || "名称なし";

        updateRenameProgress(completedCount, targets.length, `${index + 1}/${targets.length}：${displayName}`);
        setStatus(removeMetadata && isPngItem(item)
          ? `PNG情報を確認中… ${index + 1}/${targets.length}`
          : `リネーム中… ${index + 1}/${targets.length}`);
        await nextPaint();

        if (removeMetadata && await removePngMetadata(item)) cleanedPngCount += 1;
        item.name = `${number}_${requestedBaseName || oldName}`;
        await withTimeout(
          item.save(),
          30000,
          `${displayName}の名前保存が30秒以内に完了しませんでした`
        );
        completedCount = index + 1;
        updateRenameProgress(completedCount, targets.length, `${completedCount} / ${targets.length}`);
      }

      const selectedSort = document.querySelector("#sortSelect").value;
      if (selectedSort !== "manual") {
        sortItems(selectedSort);
        applyRatingFilter();
      }
      render();
      writeOrder();
      const cleanedMessage = removeMetadata ? `、PNG情報を${cleanedPngCount}件削除` : "";
      updateRenameProgress(targets.length, targets.length, `完了：${targets.length} / ${targets.length}`);
      setStatus(`${label}の連番リネーム完了（${targets.length}件${cleanedMessage}）`);
    } catch (error) {
      render();
      writeOrder();
      updateRenameProgress(completedCount, targets.length, `停止：${completedCount} / ${targets.length}`);
      setStatus(`リネームを停止しました：${error.message || "不明なエラー"}`);
    } finally {
      renameInProgress = false;
      setRenameControlsDisabled(false);
    }
  }

  async function trashUnrated() {
    const unrated = state.allItems.filter((item) => getRating(item) === 0);
    if (!unrated.length) {
      setStatus("評価なしの画像はありません");
      return;
    }
    if (unrated.length > 1 && !window.confirm(`評価なしの${unrated.length}件をEagleのゴミ箱へ移します。実行しますか？`)) return;

    setStatus("評価なし画像をゴミ箱へ移動中…");
    for (const item of unrated) await item.moveToTrash();
    state.allItems = state.allItems.filter((item) => getRating(item) !== 0);
    applyRatingFilter();
    if (!state.items.some((item) => item.id === selectedId)) {
      selectedId = null;
      updateRatingButtons();
      hidePreview();
    }
    render();
    writeOrder();
    setStatus(`評価なし画像を${unrated.length}件ゴミ箱へ移しました`);
  }

  async function renameSequentially() {
    await renameItems(state.items, "現在の表示順");
  }

  async function trashSelected() {
    const targets = getSelectedItems();
    if (!targets.length) {
      setStatus("画像を選択してください");
      return;
    }
    if (targets.length > 1 && !window.confirm(`選択した${targets.length}件をEagleのゴミ箱へ移します。実行しますか？`)) return;
    for (const item of targets) await item.moveToTrash();
    const removedIds = new Set(targets.map((item) => item.id));
    state.allItems = state.allItems.filter((item) => !removedIds.has(item.id));
    targets.forEach((item) => selectedIds.delete(item.id));
    selectedId = selectedIds.values().next().value || null;
    applyRatingFilter();
    hidePreview();
    render();
    writeOrder();
    setStatus(`${targets.length}件をゴミ箱へ移しました`);
  }

  async function changeTags(add) {
    const tag = document.querySelector("#tagInput").value.trim();
    const targets = getSelectedItems();
    if (!tag || !targets.length) {
      setStatus("画像を選択し、タグ名を入力してください");
      return;
    }
    for (const item of targets) {
      const tags = new Set(item.tags || []);
      if (add) tags.add(tag);
      else tags.delete(tag);
      item.tags = [...tags];
      await item.save();
    }
    setStatus(`${targets.length}件のタグを${add ? "追加" : "削除"}しました`);
  }

  document.querySelector("#reload").addEventListener("click", loadItems);
  document.querySelector("#sortSelect").addEventListener("change", applySelectedSort);
  tileSizeInput.addEventListener("input", (event) => applyTileSize(event.target.value));
  renameBaseNameInput.addEventListener("input", () => {
    if (state.storageKey) {
      localStorage.setItem(`${state.storageKey}:rename-base-name`, renameBaseNameInput.value);
    }
  });
  document.querySelector("#ratingFilter").addEventListener("change", () => {
    applyRatingFilter();
    render();
    setStatus(`表示を${state.items.length}件に絞り込みました`);
  });
  document.querySelector("#trashUnrated").addEventListener("click", trashUnrated);
  document.querySelector("#renameSequential").addEventListener("click", renameSequentially);
  document.querySelector("#renameSelected").addEventListener("click", () => renameItems(getSelectedItems(), "選択画像"));
  document.querySelector("#trashSelected").addEventListener("click", trashSelected);
  document.querySelector("#addTag").addEventListener("click", () => changeTags(true));
  document.querySelector("#removeTag").addEventListener("click", () => changeTags(false));
  document.querySelector("#previewPrevious").addEventListener("click", () => movePreview(-1));
  document.querySelector("#previewNext").addEventListener("click", () => movePreview(1));
  document.querySelector("#previewOpen").addEventListener("click", openInEagle);
  document.querySelector("#previewZoomOut").addEventListener("click", () => adjustPreviewZoom(-.25));
  document.querySelector("#previewZoomReset").addEventListener("click", resetPreviewTransform);
  document.querySelector("#previewZoomIn").addEventListener("click", () => adjustPreviewZoom(.25));
  document.querySelector("#previewRotate").addEventListener("click", rotatePreview);
  document.querySelector("#previewSlideshow").addEventListener("click", toggleSlideshow);
  previewOverlay.addEventListener("click", (event) => {
    if (event.target === previewOverlay) hidePreview();
  });
  previewOverlay.addEventListener("dblclick", hidePreview);
  document.addEventListener("keydown", (event) => {
    const activeTag = document.activeElement?.tagName;
    if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(activeTag)) return;

    if (event.key === "Escape") {
      hidePreview();
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      trashSelected();
      return;
    }
    if (!previewOverlay.hidden && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      movePreview(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.code === "Space" && !event.repeat) {
      event.preventDefault();
      if (previewOverlay.hidden) showPreview();
      else hidePreview();
      return;
    }

    if (!event.repeat) {
      const match = event.code.match(/^(?:Digit|Numpad)([0-5])$/);
      if (match) {
        event.preventDefault();
        setSelectedRating(Number(match[1]));
      }
    }
  });

  document.querySelectorAll("[data-rating]").forEach((button) => {
    button.addEventListener("click", () => setSelectedRating(Number(button.dataset.rating)));
  });

  eagle.onPluginCreate(loadItems);
  eagle.onPluginShow(loadItems);
  eagle.onLibraryChanged(loadItems);
})();
