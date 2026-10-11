-- Plan 08 Task 3: ListingMatch.analysisId FK'si CASCADE → NO ACTION.
-- Saklama temizliği referanssız eski analizleri siler; NOT EXISTS anlık görüntüsünden sonra eşzamanlı bir eşleşme
-- eklenirse CASCADE o eşleşmeyi (ve bildirimlerini) sessizce silerdi (dedup kaybı → NEW yeniden tetiklenir).
-- NO ACTION ile böyle bir DELETE ifade sonunda FK hatasıyla reddedilir. Listing silindiğinde eşleşmeler
-- ListingMatch_listingId_fkey (CASCADE) ile aynı ifadede silindiği için NO ACTION kontrolü yine geçer.

-- DropForeignKey
ALTER TABLE "ListingMatch" DROP CONSTRAINT "ListingMatch_analysisId_fkey";

-- AddForeignKey
ALTER TABLE "ListingMatch" ADD CONSTRAINT "ListingMatch_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "ListingAnalysis"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
