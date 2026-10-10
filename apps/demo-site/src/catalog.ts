export interface CatalogModel {
  make: string;
  model: string;
  trims: string[];
  /** Sıfır km, bu yılın modeli için yaklaşık liste fiyatı (TL) */
  basePrice: number;
  fuels: string[];
  bodyType: string;
}

export const CATALOG: CatalogModel[] = [
  { make: 'Renault', model: 'Clio', trims: ['1.0 TCe Joy', '1.5 dCi Touch'], basePrice: 1_150_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Hatchback' },
  { make: 'Fiat', model: 'Egea', trims: ['1.4 Fire Easy', '1.3 Multijet Urban'], basePrice: 1_050_000, fuels: ['Benzin', 'Dizel', 'Benzin & LPG'], bodyType: 'Sedan' },
  { make: 'Toyota', model: 'Corolla', trims: ['1.5 Vision', '1.8 Hybrid Flame'], basePrice: 1_650_000, fuels: ['Benzin', 'Hibrit'], bodyType: 'Sedan' },
  { make: 'Volkswagen', model: 'Golf', trims: ['1.0 eTSI Life', '1.5 eTSI Style'], basePrice: 1_900_000, fuels: ['Benzin'], bodyType: 'Hatchback' },
  { make: 'Volkswagen', model: 'Passat', trims: ['1.5 TSI Business', '2.0 TDI Elegance'], basePrice: 2_400_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Sedan' },
  { make: 'BMW', model: '3 Serisi', trims: ['320i', '318i', '320d'], basePrice: 3_200_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Sedan' },
  { make: 'Mercedes-Benz', model: 'C Serisi', trims: ['C 200', 'C 180'], basePrice: 3_500_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Sedan' },
  { make: 'Honda', model: 'Civic', trims: ['1.5 VTEC Elegance', '1.6 i-DTEC Executive'], basePrice: 1_750_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Sedan' },
  { make: 'Hyundai', model: 'i20', trims: ['1.4 MPI Jump', '1.0 T-GDI Style'], basePrice: 950_000, fuels: ['Benzin'], bodyType: 'Hatchback' },
  { make: 'Ford', model: 'Focus', trims: ['1.5 TDCi Trend X', '1.0 EcoBoost Titanium'], basePrice: 1_350_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Hatchback' },
  { make: 'Peugeot', model: '3008', trims: ['1.5 BlueHDi Active', '1.2 PureTech GT'], basePrice: 2_100_000, fuels: ['Benzin', 'Dizel'], bodyType: 'SUV' },
  { make: 'Dacia', model: 'Duster', trims: ['1.3 TCe Prestige', '1.5 Blue dCi Comfort'], basePrice: 1_200_000, fuels: ['Benzin', 'Dizel', 'Benzin & LPG'], bodyType: 'SUV' },
];

export const CITIES = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya', 'Kocaeli', 'Konya', 'Adana'];
export const TRANSMISSIONS = ['Manuel', 'Otomatik', 'Yarı Otomatik'];
export const COLORS = ['Beyaz', 'Siyah', 'Gri', 'Kırmızı', 'Mavi'];
export const PARTS = ['Kaput', 'Sol ön çamurluk', 'Sağ ön kapı', 'Sol arka kapı', 'Bagaj kapağı', 'Tavan'];
