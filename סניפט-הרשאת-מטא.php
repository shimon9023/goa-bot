<?php
/**
 * מאפשר לבוט הטלגרם לכתוב מטא של Yoast למוצרים דרך ה-API.
 *
 * למה צריך את זה:
 * מפתחות ה-REST של ווקומרס לא מורשים לכתוב שדות meta של פוסטים,
 * ולכן כל ניסיון של הבוט לשמור מטא כותרת ומטא תיאור נדחה
 * בשגיאה "אין לך הרשאות לערוך פוסט זה".
 *
 * מה הסניפט עושה:
 * רושם את שני שדות ה-Yoast כשדות שניתנים לכתיבה ב-API,
 * ומתיר את הכתיבה רק למי שמורשה לערוך את המוצר הספציפי.
 *
 * איך מתקינים:
 * בוורדפרס, Code Snippets, הוספת סניפט חדש.
 * שם: "הרשאת מטא לבוט". להדביק את כל הקוד, לשמור ולהפעיל.
 * להריץ פעם אחת. אחרי זה הבוט יכול לכתוב מטא.
 */

add_action( 'rest_api_init', function () {

	$fields = array(
		'_yoast_wpseo_title'    => 'מטא כותרת',
		'_yoast_wpseo_metadesc' => 'מטא תיאור',
	);

	foreach ( $fields as $key => $label ) {

		register_post_meta( 'product', $key, array(
			'type'              => 'string',
			'description'       => $label,
			'single'            => true,
			'show_in_rest'      => true,
			'sanitize_callback' => 'sanitize_text_field',

			// רק מי שמורשה לערוך את המוצר הזה יכול לכתוב את השדה
			'auth_callback'     => function ( $allowed, $meta_key, $post_id ) {
				return current_user_can( 'edit_post', $post_id );
			},
		) );
	}
} );
