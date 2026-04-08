-- Schema redesign: store additional identification/contact fields plus
-- materialize the entire `parametersDict` object as typed columns on `listings`.
--
-- We wipe historical listing data first because the tracked shape changed
-- substantially and re-scraping fresh rows was simpler than backfilling the old
-- payloads. `sources` and `scrape_runs` are kept — source configuration
-- shouldn't be lost and run history is small.

-- 1) Wipe listing-related tables. Order matters: changes → snapshots → listings
--    because of FK constraints declared in 0001_init.sql.
DELETE FROM listing_changes;
DELETE FROM listing_snapshots;
DELETE FROM listings;

-- 2) Top-level metadata that the previous schema dropped on the floor.

-- Seller info.
ALTER TABLE listings ADD COLUMN seller_uuid TEXT;
ALTER TABLE listings ADD COLUMN seller_id TEXT;
ALTER TABLE listings ADD COLUMN seller_name TEXT;
ALTER TABLE listings ADD COLUMN seller_location_city TEXT;
ALTER TABLE listings ADD COLUMN seller_location_region TEXT;
ALTER TABLE listings ADD COLUMN seller_location_lat REAL;
ALTER TABLE listings ADD COLUMN seller_location_lon REAL;

-- Marketplace-side timestamps. These differ from first_seen_at/last_seen_at which
-- track our own observation window — advert_created_at is when the seller
-- originally posted, advert_updated_at is when the upstream last touched the row,
-- and advert_original_created_at survives republishes (= the very first post).
ALTER TABLE listings ADD COLUMN advert_created_at TEXT;
ALTER TABLE listings ADD COLUMN advert_updated_at TEXT;
ALTER TABLE listings ADD COLUMN advert_original_created_at TEXT;

-- Price metadata beyond the bare amount we already store as last_price_amount.
ALTER TABLE listings ADD COLUMN price_currency TEXT;
ALTER TABLE listings ADD COLUMN price_labels_json TEXT;

-- Identification/contact fields. NULLable because not every listing exposes all
-- of these (e.g. some sellers omit registration plate).
ALTER TABLE listings ADD COLUMN vin TEXT;
ALTER TABLE listings ADD COLUMN registration TEXT;
ALTER TABLE listings ADD COLUMN date_registration TEXT;
-- phones_json shape: {"main":["509322008",...],"description":["694512812",...]}
-- "main" = primary numbers exposed on the advert
-- "description" = numbers harvested from the description HTML
ALTER TABLE listings ADD COLUMN phones_json TEXT;

-- Media + description duplication. description_text is also in listing_snapshots
-- but having it on listings lets us search without a JOIN.
ALTER TABLE listings ADD COLUMN image_count INTEGER;
ALTER TABLE listings ADD COLUMN description_text TEXT;

-- Verified-car / vehicle-class flags from the advert root.
ALTER TABLE listings ADD COLUMN verified_car INTEGER;
ALTER TABLE listings ADD COLUMN is_used_car INTEGER;
ALTER TABLE listings ADD COLUMN is_parts INTEGER;

-- 3) Every parameter from advert.parametersDict as a typed column. Generated
-- from src/lib/marketplace-source-params.js — those two lists MUST stay in sync. Adding a
-- new param means: add it to PARAMS in marketplace-source-params.js AND add an
-- ALTER TABLE in a new migration file.

-- Vehicle core
ALTER TABLE listings ADD COLUMN make TEXT;
ALTER TABLE listings ADD COLUMN model TEXT;
ALTER TABLE listings ADD COLUMN year INTEGER;
ALTER TABLE listings ADD COLUMN mileage INTEGER;
ALTER TABLE listings ADD COLUMN body_type TEXT;
ALTER TABLE listings ADD COLUMN color TEXT;
ALTER TABLE listings ADD COLUMN colour_type TEXT;
ALTER TABLE listings ADD COLUMN door_count INTEGER;
ALTER TABLE listings ADD COLUMN nr_seats INTEGER;
ALTER TABLE listings ADD COLUMN upholstery_type TEXT;
ALTER TABLE listings ADD COLUMN rhd INTEGER;
ALTER TABLE listings ADD COLUMN has_vin INTEGER;
ALTER TABLE listings ADD COLUMN has_registration INTEGER;

-- Powertrain
ALTER TABLE listings ADD COLUMN fuel_type TEXT;
ALTER TABLE listings ADD COLUMN engine_power INTEGER;
ALTER TABLE listings ADD COLUMN engine_capacity INTEGER;
ALTER TABLE listings ADD COLUMN gearbox TEXT;
ALTER TABLE listings ADD COLUMN transmission TEXT;

-- EV-specific
ALTER TABLE listings ADD COLUMN autonomy INTEGER;
ALTER TABLE listings ADD COLUMN avg_consumption REAL;
ALTER TABLE listings ADD COLUMN battery_capacity REAL;
ALTER TABLE listings ADD COLUMN battery_type TEXT;
ALTER TABLE listings ADD COLUMN electric_power_peak INTEGER;
ALTER TABLE listings ADD COLUMN brake_energy_recovery TEXT;
ALTER TABLE listings ADD COLUMN energy_recovery_system INTEGER;
ALTER TABLE listings ADD COLUMN quick_charging_function INTEGER;
ALTER TABLE listings ADD COLUMN vehicle_charging_cable INTEGER;

-- Condition / origin params (damaged / no_accident / service_record /
-- original_owner / is_imported_car / tuning / historical_vehicle / registered /
-- new_used / country_origin) live in migration 0002_add_condition_fields.sql —
-- not re-added here. They are still populated through the same extractParams()
-- pipeline going forward; nothing is dropped.

-- Safety (boolean)
ALTER TABLE listings ADD COLUMN abs INTEGER;
ALTER TABLE listings ADD COLUMN traction_control INTEGER;
ALTER TABLE listings ADD COLUMN esp INTEGER;
ALTER TABLE listings ADD COLUMN brake_assist INTEGER;
ALTER TABLE listings ADD COLUMN power_assisted_brakes INTEGER;
ALTER TABLE listings ADD COLUMN distribution_of_braking_force_electronically INTEGER;
ALTER TABLE listings ADD COLUMN driver_airbag INTEGER;
ALTER TABLE listings ADD COLUMN passenger_airbag INTEGER;
ALTER TABLE listings ADD COLUMN side_airbag_driver_and_passenger INTEGER;
ALTER TABLE listings ADD COLUMN head_airbags_front INTEGER;
ALTER TABLE listings ADD COLUMN head_airbags_rear INTEGER;
ALTER TABLE listings ADD COLUMN knee_airbag_driver INTEGER;
ALTER TABLE listings ADD COLUMN knee_airbag_passenger INTEGER;
ALTER TABLE listings ADD COLUMN pre_crash_system INTEGER;
ALTER TABLE listings ADD COLUMN rear_pre_crash_system INTEGER;
ALTER TABLE listings ADD COLUMN side_pre_crash_system INTEGER;
ALTER TABLE listings ADD COLUMN pre_crash_sound_system INTEGER;
ALTER TABLE listings ADD COLUMN active_emergency_brake_assist INTEGER;
ALTER TABLE listings ADD COLUMN city_emergency_brake_assist INTEGER;
ALTER TABLE listings ADD COLUMN pedestrian_emergency_brake_assist INTEGER;
ALTER TABLE listings ADD COLUMN roll_over_protection_system INTEGER;
ALTER TABLE listings ADD COLUMN child_seat_fixation INTEGER;
ALTER TABLE listings ADD COLUMN blind_spot_warning INTEGER;
ALTER TABLE listings ADD COLUMN collision_warning_system INTEGER;
ALTER TABLE listings ADD COLUMN automatic_emergency_call INTEGER;
ALTER TABLE listings ADD COLUMN acoustic_vehicle_alerting_system INTEGER;
ALTER TABLE listings ADD COLUMN tyre_pressure_control INTEGER;

-- Comfort
ALTER TABLE listings ADD COLUMN air_conditioning_type TEXT;
ALTER TABLE listings ADD COLUMN air_condition_rear INTEGER;
ALTER TABLE listings ADD COLUMN automatic_heating_control INTEGER;
ALTER TABLE listings ADD COLUMN independent_vehicle_heater INTEGER;
ALTER TABLE listings ADD COLUMN windscreen_heating INTEGER;
ALTER TABLE listings ADD COLUMN air_suspension INTEGER;
ALTER TABLE listings ADD COLUMN adjustable_suspension INTEGER;
ALTER TABLE listings ADD COLUMN comfort_suspension INTEGER;
ALTER TABLE listings ADD COLUMN sport_suspension INTEGER;
ALTER TABLE listings ADD COLUMN hydro_pneumatic_suspension INTEGER;
ALTER TABLE listings ADD COLUMN electronic_controlled_suspension INTEGER;
ALTER TABLE listings ADD COLUMN heated_seat_driver INTEGER;
ALTER TABLE listings ADD COLUMN heated_seat_passenger INTEGER;
ALTER TABLE listings ADD COLUMN ventilated_front_seat INTEGER;
ALTER TABLE listings ADD COLUMN sport_seats_front INTEGER;
ALTER TABLE listings ADD COLUMN driver_seat_electrically_adjustable INTEGER;
ALTER TABLE listings ADD COLUMN passenger_seat_electrically_adjustable INTEGER;
ALTER TABLE listings ADD COLUMN memory_seat INTEGER;
ALTER TABLE listings ADD COLUMN lumbar_adjust_driver_electric INTEGER;
ALTER TABLE listings ADD COLUMN lumbar_adjust_passenger_electric INTEGER;
ALTER TABLE listings ADD COLUMN power_windows_front INTEGER;
ALTER TABLE listings ADD COLUMN power_windows_rear INTEGER;
ALTER TABLE listings ADD COLUMN power_steering INTEGER;
ALTER TABLE listings ADD COLUMN steering_wheel_heated INTEGER;
ALTER TABLE listings ADD COLUMN steering_wheel_electrically_adjustable INTEGER;
ALTER TABLE listings ADD COLUMN steering_wheel_with_radio_operation INTEGER;
ALTER TABLE listings ADD COLUMN multi_functional_steering_wheel INTEGER;
ALTER TABLE listings ADD COLUMN sports_steering_wheel INTEGER;
ALTER TABLE listings ADD COLUMN leather_steering_wheel INTEGER;
ALTER TABLE listings ADD COLUMN armrest_front INTEGER;
ALTER TABLE listings ADD COLUMN armrest_rear INTEGER;
ALTER TABLE listings ADD COLUMN sunroof TEXT;
ALTER TABLE listings ADD COLUMN tinted_rear_windows INTEGER;
ALTER TABLE listings ADD COLUMN approval_for_goods INTEGER;
ALTER TABLE listings ADD COLUMN cant_see_my_version INTEGER;
ALTER TABLE listings ADD COLUMN autorenew INTEGER;

-- Tech / infotainment
ALTER TABLE listings ADD COLUMN navigation_system INTEGER;
ALTER TABLE listings ADD COLUMN radio INTEGER;
ALTER TABLE listings ADD COLUMN touchscreen_monitor INTEGER;
ALTER TABLE listings ADD COLUMN internet_access INTEGER;
ALTER TABLE listings ADD COLUMN android_auto INTEGER;
ALTER TABLE listings ADD COLUMN apple_carplay INTEGER;
ALTER TABLE listings ADD COLUMN bluetooth_interface INTEGER;
ALTER TABLE listings ADD COLUMN hands_free_system INTEGER;
ALTER TABLE listings ADD COLUMN voice_control_for_vehicle_functions INTEGER;
ALTER TABLE listings ADD COLUMN usb_in INTEGER;
ALTER TABLE listings ADD COLUMN wireless_device_charging INTEGER;
ALTER TABLE listings ADD COLUMN soundsystem INTEGER;
ALTER TABLE listings ADD COLUMN keyless_engine_start INTEGER;
ALTER TABLE listings ADD COLUMN startstop_system INTEGER;
ALTER TABLE listings ADD COLUMN digital_key INTEGER;
ALTER TABLE listings ADD COLUMN electric_parking_brake INTEGER;

-- Driver assist
ALTER TABLE listings ADD COLUMN cruisecontrol_type TEXT;
ALTER TABLE listings ADD COLUMN lane_control_assistant INTEGER;
ALTER TABLE listings ADD COLUMN active_lane_change_assistant INTEGER;
ALTER TABLE listings ADD COLUMN distance_control INTEGER;
ALTER TABLE listings ADD COLUMN traffic_sign_recognition INTEGER;
ALTER TABLE listings ADD COLUMN curve_trace_assistant INTEGER;
ALTER TABLE listings ADD COLUMN speed_limiter INTEGER;
ALTER TABLE listings ADD COLUMN park_assistant INTEGER;
ALTER TABLE listings ADD COLUMN park_distance_control_front INTEGER;
ALTER TABLE listings ADD COLUMN park_distance_control_rear INTEGER;
ALTER TABLE listings ADD COLUMN autonomous_parking_system INTEGER;

-- Lighting
ALTER TABLE listings ADD COLUMN headlight_lamp_type TEXT;
ALTER TABLE listings ADD COLUMN adaptive_light INTEGER;
ALTER TABLE listings ADD COLUMN cornering_headlights INTEGER;
ALTER TABLE listings ADD COLUMN dynamic_directional_lights INTEGER;
ALTER TABLE listings ADD COLUMN daytime_running_lights INTEGER;
ALTER TABLE listings ADD COLUMN led_daytime_running_lights INTEGER;
ALTER TABLE listings ADD COLUMN automated_high_beam_assist INTEGER;
ALTER TABLE listings ADD COLUMN automatic_dimlight_activation INTEGER;
ALTER TABLE listings ADD COLUMN follow_me_home INTEGER;
ALTER TABLE listings ADD COLUMN fog_lamps INTEGER;
ALTER TABLE listings ADD COLUMN led_interior_lighting INTEGER;
ALTER TABLE listings ADD COLUMN rain_sensor INTEGER;

-- Mirrors / cameras (view_360_camera = renamed from `360_view_camera` because
-- the original key starts with a digit and is awkward as an identifier)
ALTER TABLE listings ADD COLUMN door_mirror_electrically_adjustable_in_general INTEGER;
ALTER TABLE listings ADD COLUMN door_mirrors_electrically_foldable INTEGER;
ALTER TABLE listings ADD COLUMN door_mirrors_heated INTEGER;
ALTER TABLE listings ADD COLUMN door_mirror_camera INTEGER;
ALTER TABLE listings ADD COLUMN rear_view_camera INTEGER;
ALTER TABLE listings ADD COLUMN view_360_camera INTEGER;

-- Wheels / tires / brakes
ALTER TABLE listings ADD COLUMN alloy_wheels_type TEXT;
ALTER TABLE listings ADD COLUMN tyre_type TEXT;
ALTER TABLE listings ADD COLUMN ceramic_composite_brakes INTEGER;
ALTER TABLE listings ADD COLUMN particle_filter INTEGER;
ALTER TABLE listings ADD COLUMN windscreenwiper_other INTEGER;

-- 4) Indexes for the most likely query shapes (price/spec filters in the UI,
-- VIN lookups for re-identification across listings, seller_uuid grouping for
-- "all listings of this dealer").
CREATE INDEX IF NOT EXISTS idx_listings_vin ON listings(vin);
CREATE INDEX IF NOT EXISTS idx_listings_seller_uuid ON listings(seller_uuid);
CREATE INDEX IF NOT EXISTS idx_listings_make_model ON listings(make, model);
CREATE INDEX IF NOT EXISTS idx_listings_year ON listings(year);
CREATE INDEX IF NOT EXISTS idx_listings_mileage ON listings(mileage);
CREATE INDEX IF NOT EXISTS idx_listings_fuel_type ON listings(fuel_type);
