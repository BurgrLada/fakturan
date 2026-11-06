-- invoice.search_text in src/lib/text-limits.ts: an import could build a longer one, which a restore refuses.
UPDATE `invoice` SET `search_text` = substr(`search_text`, 1, 110000) WHERE length(`search_text`) > 110000;
