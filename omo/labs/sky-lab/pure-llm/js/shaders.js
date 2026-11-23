// Shared GLSL chunks: noise, dusk sky (analytic scattering approximation), aerial-perspective haze.

export const NOISE = /* glsl */`
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash11(float p){ p=fract(p*.1031); p*=p+33.33; p*=p+p; return fract(p); }
vec2 hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x),u.y); }
float fbm(vec2 p){ float a=.5,s=0.; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<6;i++){ s+=a*vnoise(p); p=m*p; a*=.5; } return s; }
float fbm3(vec2 p){ float a=.5,s=0.; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<3;i++){ s+=a*vnoise(p); p=m*p; a*=.5; } return s/0.875; }
// tileable value noise / fbm (period in lattice units)
float tnoise(vec2 p, vec2 per){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  float a=hash12(mod(i,per)), b=hash12(mod(i+vec2(1,0),per)), c=hash12(mod(i+vec2(0,1),per)), d=hash12(mod(i+vec2(1,1),per));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float tfbm(vec2 p, vec2 per){ float a=.5,s=0.; for(int i=0;i<6;i++){ s+=a*tnoise(p,per); p*=2.; per*=2.; a*=.5; } return s; }
// exact box-filtered pulse coverage: |x|<hw, filtered over footprint w
float boxCov(float x, float hw, float w){ w=max(w,1e-4); float a=clamp(x+w*.5,-hw,hw), b=clamp(x-w*.5,-hw,hw); return (a-b)/w; }
`;

export const SKY = /* glsl */`
uniform vec3 uSunDir;
uniform float uTime;
vec3 skyColor(vec3 d){
  d = normalize(d);
  float h = d.y;
  vec3 s = uSunDir;
  vec2 dh = normalize(d.xz + 1e-5), sh = normalize(s.xz);
  float az = dot(dh, sh)*.5+.5;          // 1 toward sun azimuth
  float mu = dot(d, s);
  float hh = max(h, 0.);
  vec3 zenith = vec3(0.010,0.024,0.075);
  vec3 mid    = vec3(0.045,0.085,0.21);
  vec3 horSun = vec3(1.55,0.58,0.20);
  vec3 horMid = vec3(0.62,0.34,0.36);
  vec3 horAway= vec3(0.17,0.16,0.27);
  vec3 hor = mix(horAway, mix(horMid, horSun, smoothstep(.55,1.,az)), smoothstep(0.,.75,az));
  float t1 = pow(1.-hh, 7.0);
  float t2 = pow(1.-hh, 2.2);
  vec3 col = mix(zenith, mid, t2);
  col = mix(col, hor, t1);
  // forward (Mie-like) glow around the set sun
  float g = max(mu,0.);
  col += vec3(1.9,0.75,0.26) * pow(g,14.) * exp(-hh*5.);
  col += vec3(0.55,0.24,0.10) * pow(g,3.) * exp(-hh*9.);
  // earth shadow + belt of Venus on the anti-solar side
  float anti = pow(1.-az, 1.6);
  col = mix(col, vec3(0.07,0.08,0.16), anti*exp(-hh*22.)*.55);
  col += vec3(0.16,0.07,0.12) * anti * exp(-pow((hh-.075)/.045,2.));
  // below the horizon: dark ground with warm city glow and haze band
  if(h < 0.){
    float b = clamp(-h*6., 0., 1.);
    vec3 ground = vec3(0.020,0.017,0.022) + vec3(0.10,0.05,0.022)*exp(h*10.);
    col = mix(hor*.65, ground, b);
  }
  return col;
}
`;

export const HAZE = /* glsl */`
vec3 applyHaze(vec3 col, vec3 wp){
  vec3 v = wp - cameraPosition; float d = length(v); vec3 dir = v/d;
  float hAvg = (wp.y + cameraPosition.y)*.5 + 300.;
  float dens = 0.00020*exp(-max(hAvg,0.)/700.) + 0.000025;
  float f = 1. - exp(-d*dens);
  vec3 fc = skyColor(normalize(vec3(dir.x, 0.004, dir.z)));
  fc = mix(fc, fc*0.6 + vec3(0.05,0.03,0.016), 0.5);
  return mix(col, fc, f);
}
`;
