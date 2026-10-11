// Punto { latitude, longitude } que llega desde la app (el pin que el cliente
// marca en el mapa). Devuelve el punto con números válidos o null si falta o
// no tiene sentido; así nunca se guarda basura en una dirección o un pedido.
export const parseGeoPoint = (value) => {
  if (!value || value.latitude == null || value.longitude == null) return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  // 0,0 es lo que mandan algunos GPS cuando no tienen señal.
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
};

export default { parseGeoPoint };
