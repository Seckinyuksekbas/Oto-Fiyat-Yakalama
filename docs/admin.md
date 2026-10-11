# Admin paneli

> Bu belge Plan 07 Task 13'te tamamlanacaktır; şimdilik yalnızca API davranışına dair notlar içerir.

## Paket limitleri

- `PATCH /admin/plans/:id` limitleri düşürdüğünde mevcut kullanıcıların fazla ACTIVE arama profilleri **duraklatılmaz**. Kullanıcılar fazla profillerini bir sonraki abonelik değişimine (admin abonelik değişimi ya da süresi dolan abonelik süpürmesi) kadar korur. Yeni profil oluşturma ve etkinleştirme ise yeni limitle hemen sınırlanır.
- Yanıttaki `plan.usersOverProfileLimit`, canlı paketi bu olan kullanıcılardan ACTIVE profil sayısı yeni `maxSearchProfiles` sınırını aşanların sayısıdır. FREE için aboneliği olmayan (örtük FREE) kullanıcılar da sayılır. Sınır `maxSearchProfilesFor` ile hesaplanır, yani e-postası doğrulanmamış kullanıcılar için en fazla 1'dir.
- FREE paketi pasifleştirilemez (409). Paket kodları değiştirilemez. Limitlerde `IN_APP` kanalı zorunludur.
- Aktif abonesi olan bir paket pasifleştirilebilir: mevcut abonelikler sürer, ancak pakete yeni atama yapılamaz (409).
