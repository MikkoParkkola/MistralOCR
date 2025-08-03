function cleanDocument(doc) {
  ["header", "nav", "footer", "script", "style", "aside", "iframe", "noscript"].forEach((sel) => {
    doc.querySelectorAll(sel).forEach((el) => el.remove());
  });
}

console.log("mistralocr: content script loaded");

function nodeToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  const tag = node.tagName.toLowerCase();
  let content = Array.from(node.childNodes).map(nodeToMarkdown).join("");
  switch (tag) {
    case "h1":
      return "# " + content + "\n\n";
    case "h2":
      return "## " + content + "\n\n";
    case "h3":
      return "### " + content + "\n\n";
    case "strong":
    case "b":
      return "**" + content + "**";
    case "em":
    case "i":
      return "*" + content + "*";
    case "p":
      return content + "\n\n";
    case "br":
      return "\n";
    case "li":
      return "- " + content + "\n";
    case "ul":
    case "ol":
      return "\n" + content + "\n";
    case "a":
      return `[${content}](${node.getAttribute("href") || ""})`;
    case "img":
      return `![${node.getAttribute("alt") || ""}](${node.getAttribute("src") || ""})`;
    default:
      return content;
  }
}

function htmlToMarkdown(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return nodeToMarkdown(div);
}

function getPageMarkdown() {
  const docClone = document.cloneNode(true);
  cleanDocument(docClone);
  const main = docClone.querySelector("main");
  const target = main || docClone.body;
  return htmlToMarkdown(target.innerHTML);
}

function getSelectionMarkdown() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  const div = document.createElement("div");
  div.appendChild(range.cloneContents());
  return htmlToMarkdown(div.innerHTML);
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  console.log("mistralocr: content script request", req.type);
  if (req.type === "getPage") {
    sendResponse({ markdown: getPageMarkdown() });
  } else if (req.type === "getSelection") {
    sendResponse({ markdown: getSelectionMarkdown() });
  }
});

//# sourceURL=content.js
