# Prompt Cacher

Prompt Cacher is a Chrome extension for claude.ai. It saves a prompt together with the files you attached to it, so you can use the same prompt and files again with one click.

## The problem

Many people use Claude for the same task over and over. A student preparing for a psychology exam might ask Claude for practice questions every few days, and attach the same five sets of lecture slides each time. A job seeker might paste the same resume review request and attach the same resume and job description.

Saving the text of a prompt is easy. You can keep it in a notes app and paste it in. The files are the slow part. Every time, you have to open the file picker, find each file in your folders, and attach it again. With five or six files, that takes longer than writing the prompt.

## The solution

Prompt Cacher adds a **Save prompt** button above the claude.ai message box. When you click it, the extension saves the text you typed and a copy of every file you attached.

Later, you open the Prompt Cacher panel on the side of your browser. You find the prompt you want, either by scrolling or by typing a few words into the search bar. Then you click **Insert**. The text and all the files go back into the claude.ai message box, ready to send.

Everything stays on your computer. The extension does not send your prompts or files to any other server, and it does not use an AI service to search.

## How to use it

**Install**

1. Download or clone this folder.
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Refresh any claude.ai tabs you already have open.

**Save a prompt**

1. On claude.ai, type your prompt and attach your files as usual.
2. Click **Save prompt** above the message box. The Prompt Cacher panel opens.
3. Give the prompt a title and, if you like, some tags. Each file shows "Saving a copy…" and then its size once the copy is stored.
4. Click **Save**.

**Reuse a prompt**

1. Open a new chat on claude.ai.
2. Open the panel with the toolbar icon or Cmd+Shift+Y (Ctrl+Shift+Y on Windows).
3. Search or scroll to the prompt and click **Insert**. Pressing Enter in the search bar inserts the top result.
4. Check the message and send it.

You can also edit a saved prompt, remove or add files, or delete it from the panel.

## How it works

**Reading the prompt.** The extension reads the text in the claude.ai message box, one line at a time.

**Getting the files back.** This was the hard part. When you attach a file on claude.ai, it is uploaded to Anthropic's servers right away. The page itself only shows a small card with the file name. It does not keep the file in a form the extension can simply pick up.

However, claude.ai does keep a record of your unsent message in your browser, so that your draft survives a page refresh. That record lists every attached file and where it was uploaded. When you click Save, the extension reads that record and downloads each file back from claude.ai, using the login you already have. We checked that the downloaded copies are identical to the originals for PDF, PowerPoint and text files.

Text files (.txt, .md and code files) work a little differently. claude.ai never uploads them. It reads their text in your browser and keeps that text in the same record, so the extension takes the text from there.

If a copy fails for any reason, the file is marked in the panel and you can link the file from your computer instead.

**Storing.** Prompts and file copies are kept in IndexedDB, a database built into Chrome. It lives on your computer and belongs only to this extension.

**Inserting.** The extension rebuilds each saved file and hands it to claude.ai's upload box, the same way it would receive a file you picked yourself. Then it pastes the prompt text into the message box.

**Searching.** The search bar matches words in the title, the prompt text, the tags and the file names. It also accepts partial words and small typos.

**What the extension does not do.** It does not read or copy anything when you attach a file. It only reads your message and files when you click Save.

## Tech stack

- **Chrome extension, Manifest V3.** Installed with "Load unpacked". It is not on the Chrome Web Store.
- **Plain JavaScript, HTML and CSS.** No framework and no build step. What is in the folder is what Chrome runs.
- **Chrome side panel** for the main window, so it stays open next to claude.ai.
- **IndexedDB** for storing prompts and files. It handles large files, unlike Chrome's simpler storage options.
- **[MiniSearch](https://github.com/lucaong/minisearch) 7.2** for keyword search. It is copied into `vendor/` so the extension loads no code from the internet.

## Project structure

```
manifest.json             Tells Chrome what the extension is and what it may access
src/
  background.js           Opens the side panel and passes short messages between parts
  content/                Scripts that run inside the claude.ai page
    selectors.js          Every claude.ai page detail the extension depends on, in one place
    extract.js            Reads the attached file list and downloads the file copies
    composer.js           Reads the prompt, and puts text and files back into the message box
    bridge.js             Connects the claude.ai page to the extension's database
    main.js               The Save prompt button, and replies to requests from the panel
  bridge/                 A hidden page that writes to and reads from the database
  db/db.js                The database: saved prompts, files, and unfinished saves
  search/index.js         Search over saved prompts
  sidepanel/              The panel you see: library, search, and the save/edit form
vendor/minisearch.js      The search library
```

A note on `bridge`: scripts inside the claude.ai page cannot write to the extension's database directly. Chrome keeps each website's storage separate. The page script therefore places a small hidden page from the extension inside claude.ai, and passes files to it through a private channel. This avoids converting files to text, which would be slow for large files.

## Limits

- **claude.ai can change.** The extension depends on how the claude.ai page is built and on web addresses claude.ai uses internally. If claude.ai changes them, saving or inserting may stop working until the extension is updated. The page details live in `src/content/selectors.js` and `src/content/extract.js`.
- **Insert replaces the message box.** Anything already typed there is cleared.
- **Linked files can go missing.** A file linked from your computer (instead of copied) stops working if you move or rename it. The panel marks it, and you can link it again.
- **Disk space.** Copies take up real space. The panel footer shows how much the library uses.
- **Search matches words, not meaning.** Searching "memory" will not find a prompt that only says "recall". Search by meaning is planned.
