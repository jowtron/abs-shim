-- Seed: example library "Audiobooks" with two books — The Hobbit (no chapters)
-- and Bobiverse Book 5 (76 chapters). The URLs below are placeholders; real
-- folders are added via the /admin UI at runtime (storage adapter picks up
-- pCloud OAuth, S3, WebDAV credentials from D1, not from this file).
--
-- If you want this seed to actually serve files, replace
-- `https://example.com/YOUR_PUBLIC_FOLDER_ID/...` below with your own
-- public-folder URL (e.g. filedn.com pCloud public-folder URLs work directly).
--
-- Apply with:  npm run db:seed:local
-- Idempotent only via DELETE-first; comment those out if you want to add more.

DELETE FROM chapters;
DELETE FROM audio_files;
DELETE FROM book_metadata;
DELETE FROM library_items;
DELETE FROM library_folders;
DELETE FROM libraries;

INSERT INTO libraries (id, name, display_order, media_type, icon, provider, settings, created_at, updated_at)
VALUES ('lib-audiobooks-001', 'Audiobooks', 1, 'book', 'audiobookshelf', 'audible', '{}',
        unixepoch('subsec') * 1000, unixepoch('subsec') * 1000);

INSERT INTO library_folders (id, library_id, filedn_base_url, added_at)
VALUES ('fold-filedn-001', 'lib-audiobooks-001',
        'https://example.com/YOUR_PUBLIC_FOLDER_ID/audiobooks/',
        unixepoch('subsec') * 1000);

-- ───── The Hobbit ──────────────────────────────────────────────────────────
INSERT INTO library_items (id, library_id, folder_id, ino, rel_path, is_file, media_type, is_missing, is_invalid, created_at, updated_at)
VALUES ('it-hobbit-001', 'lib-audiobooks-001', 'fold-filedn-001', '10001', 'The Hobbit', 0, 'book', 0, 0,
        unixepoch('subsec') * 1000, unixepoch('subsec') * 1000);

INSERT INTO book_metadata (library_item_id, title, title_ignore_prefix, subtitle, author_name, narrator_name, series_name, series_sequence, description, isbn, asin, language, publish_year, publisher, genres, tags, explicit, abridged, cover_url)
VALUES ('it-hobbit-001', 'The Hobbit', 'Hobbit, The', NULL, 'J.R.R. Tolkien', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["Audiobook"]', '[]', 0, 0, NULL);

INSERT INTO audio_files (id, library_item_id, index_no, filedn_url, ino, duration_seconds, size_bytes, mime_type, format, codec, bitrate, sample_rate, channels, added_at)
VALUES ('af-hobbit-001', 'it-hobbit-001', 1,
        'https://example.com/YOUR_PUBLIC_FOLDER_ID/audiobooks/The%20Hobbit/The%20Hobbit.m4b',
        '10002', 12737.216, 199834683, 'audio/mp4', 'mp4', 'aac', 122345, 48000, 2,
        unixepoch('subsec') * 1000);

-- ───── Bobiverse Book 5 ────────────────────────────────────────────────────
INSERT INTO library_items (id, library_id, folder_id, ino, rel_path, is_file, media_type, is_missing, is_invalid, created_at, updated_at)
VALUES ('it-bobi-001', 'lib-audiobooks-001', 'fold-filedn-001', '20001', 'Not Till We Are Lost [B0CW23CC7L]', 0, 'book', 0, 0,
        unixepoch('subsec') * 1000, unixepoch('subsec') * 1000);

INSERT INTO book_metadata (library_item_id, title, title_ignore_prefix, subtitle, author_name, narrator_name, series_name, series_sequence, description, isbn, asin, language, publish_year, publisher, genres, tags, explicit, abridged, cover_url)
VALUES ('it-bobi-001', 'Not Till We Are Lost', 'Not Till We Are Lost', 'Bobiverse, Book 5',
        'Dennis E. Taylor', 'Ray Porter', 'Bobiverse', '5',
        'The Bobiverse is a different place in the aftermath of the Starfleet War, and the days of the Bobs gathering in one big happy moot are far behind. There''s anti-Bob sentiment on multiple planets, the Skippies playing with an AI time bomb, and multiple Bobs just wanting to get away from it all. But it all pales compared to what Icarus and Daedalus discover on their 26,000-year journey to the center of the galaxy.',
        NULL, 'B0CW23CC7L', 'English', 2024, 'Audible Originals',
        '["Space Exploration"]', '[]', 0, 0, NULL);

INSERT INTO audio_files (id, library_item_id, index_no, filedn_url, ino, duration_seconds, size_bytes, mime_type, format, codec, bitrate, sample_rate, channels, added_at)
VALUES ('af-bobi-001', 'it-bobi-001', 1,
        'https://example.com/YOUR_PUBLIC_FOLDER_ID/audiobooks/Not%20Till%20We%20Are%20Lost%20%5BB0CW23CC7L%5D/Not%20Till%20We%20Are%20Lost_%20Bobiverse%2C%20Book%205%20%5BB0CW23CC7L%5D.m4b',
        '20002', 42100.564172, 668829562, 'audio/mp4', 'mp4', 'aac', 125588, 48000, 2,
        unixepoch('subsec') * 1000);

-- 76 chapters extracted from fixture
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 0, 'Opening Credits', 0, 12.28);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 1, 'Dedication', 12.28, 15.67898);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 2, 'Epigraph', 15.67898, 45.320975);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 3, '1. Destination Galactic Center', 45.320975, 446.007959);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 4, '2. Mending Fences', 446.007959, 623.825941);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 5, '3. What''s Up?', 623.825941, 762.819932);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 6, '4. A Foreboding Conversation', 762.819932, 1344.664921);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 7, '5. Mystery System', 1344.664921, 2123.136916);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 8, '6. The Quickening', 2123.136916, 3119.527914);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 9, '7. Political Comeback', 3119.527914, 3529.521905);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 10, '8. Wormholes', 3529.521905, 4110.437891);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 11, '9. Security Clampdown', 4110.437891, 5034.173878);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 12, '10. Election Victory', 5034.173878, 5189.839864);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 13, '11. Frustrations', 5189.839864, 5517.124853);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 14, '12. Tech Sleuthing', 5517.124853, 6045.470839);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 15, '13. It Hits the Fan', 6045.470839, 6859.375828);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 16, '14. Network Tours', 6859.375828, 7440.988821);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 17, '15. Imposter Syndrome', 7440.988821, 7741.848821);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 18, '16. Theresa''s Time', 7741.848821, 8667.116803);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 19, '17. Strategy Session', 8667.116803, 9004.339796);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 20, '18. Explorations', 9004.339796, 9332.460794);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 21, '19. Working the Problem', 9332.460794, 9596.401791);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 22, '20. Spectacular Nature', 9596.401791, 10005.629773);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 23, '21. Running Tests', 10005.629773, 10247.418753);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 24, '22. A Visit to the Moot Pub', 10247.418753, 11459.871746);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 25, '23. Huey', 11459.871746, 12448.623741);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 26, '24. Arachnophobia', 12448.623741, 12806.210726);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 27, '25. Building the Quiniverse', 12806.210726, 13461.802721);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 28, '26. Building Dragons', 13461.802721, 14321.102721);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 29, '27. Positive Results', 14321.102721, 14681.498707);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 30, '28. Wish Granted', 14681.498707, 15241.307687);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 31, '29. Ready to Go', 15241.307687, 16220.237687);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 32, '30. Revisions', 16220.237687, 16450.532676);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 33, '31. Huey Progress', 16450.532676, 16852.376667);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 34, '32. Second Wave', 16852.376667, 17038.182653);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 35, '33. Finally Working', 17038.182653, 17508.548639);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 36, '34. Prototype', 17508.548639, 18471.781633);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 37, '35. Travel Plans', 18471.781633, 18717.680612);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 38, '36. The Gamers Come Through', 18717.680612, 18993.440612);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 39, '37. Schemes', 18993.440612, 19930.365601);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 40, '38. Starfleet Just Won’t Go Away', 19930.365601, 20161.612585);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 41, '39. A Civil Discussion', 20161.612585, 20617.373583);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 42, '40. Going In', 20617.373583, 21969.703583);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 43, '41. A Disturbing Discovery', 21969.703583, 22476.292562);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 44, '42. Flying Around', 22476.292562, 23083.377551);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 45, '43. Learning Curve', 23083.377551, 23675.903537);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 46, '44. Investigation', 23675.903537, 24269.637528);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 47, '45. Everyone Goes Ballistic', 24269.637528, 24589.886508);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 48, '46. Moot Time', 24589.886508, 25029.857506);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 49, '47. Assimilation', 25029.857506, 26766.872494);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 50, '48. Gunther''s World', 26766.872494, 27279.429478);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 51, '49. The Quiniverse', 27279.429478, 27625.708458);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 52, '50. The Big Guy', 27625.708458, 28628.113447);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 53, '51. Accusation', 28628.113447, 29197.257438);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 54, '52. Re-Arrival', 29197.257438, 29798.630431);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 55, '53. Preparations', 29798.630431, 30490.166417);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 56, '54. Education', 30490.166417, 30996.523401);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 57, '55. Setting Off', 30996.523401, 32889.622381);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 58, '56. Graduation', 32889.622381, 33228.424376);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 59, '57. Marathon', 33228.424376, 33603.728367);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 60, '58. Special Delivery', 33603.728367, 34023.498367);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 61, '59. Showdown', 34023.498367, 34583.423356);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 62, '60. Encounter', 34583.423356, 35670.604354);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 63, '61. First Test', 35670.604354, 36960.263333);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 64, '62. Dragon Report', 36960.263333, 37176.998322);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 65, '63. A New Beginning', 37176.998322, 37701.443311);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 66, '64. Something Interesting', 37701.443311, 37840.437302);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 67, '65. The Black Hole', 37840.437302, 38138.395283);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 68, '66. In System', 38138.395283, 38347.955283);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 69, '67. Perpetrator', 38347.955283, 39024.56127);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 70, '68. Federation Capital', 39024.56127, 39560.106259);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 71, '69. Trouble', 39560.106259, 40298.268254);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 72, '70. Bill Gets a Call', 40298.268254, 40623.672245);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 73, '71. The Moot', 40623.672245, 41442.663243);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 74, '72. Human Fallout', 41442.663243, 42058.960227);
INSERT INTO chapters (library_item_id, chapter_index, title, start_seconds, end_seconds) VALUES ('it-bobi-001', 75, 'End Credits', 42058.960227, 42100.517959);
