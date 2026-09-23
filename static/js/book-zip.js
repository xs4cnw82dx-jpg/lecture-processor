/* global require */
// Bundled locally so private book backups never need a third-party script.
const {zipSync, unzipSync, strToU8, strFromU8}=require('fflate');
window.BookZip={zipSync,unzipSync,strToU8,strFromU8};
